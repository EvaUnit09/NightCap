import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createProductionSaveHandler,
  createProductionSharedPlanHandler,
  createSavePlanHandler,
  createSharedPlanHandler,
  isShareSlug,
  loadSharedPlanPage,
} from "../../src/api/share";
import {
  createConfirmHandler,
  createGoTrueAuth,
  createMagicLinkHandler,
  createSessionHandler,
  readCookie,
  userIdFromRequest,
  type MagicLinkAuth,
} from "../../src/auth/magic-link";
import { createSpendStore, createMemorySpendRedis } from "../../src/monitoring/spend-store";
import { databaseUrl } from "../../src/db/postgres";
import { savePlan, type PlaceDetailsLookup } from "../../src/monitoring";
import { OPTION_A, REQUEST_TEXT } from "../pipeline/orchestrator-harness";
import { createMigratedDatabase } from "../migrations/harness";

const HASH_SECRET = "test-hash-secret";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const MISSING = "33333333-3333-4333-8333-333333333333";

const META = {
  promptVersions: { parse_intent: "v1", plan_itineraries: "v1", repair_itinerary: "v1" },
  models: { parse_intent: "claude-haiku-5-5", plan_itineraries: "claude-haiku-5-5" },
  costUsd: 0.012,
  latencyMs: 40,
} as const;

function memoryStore() {
  return createSpendStore(createMemorySpendRedis());
}

function post(url: string, body: unknown, cookie?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (cookie) headers.set("cookie", cookie);
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

function cookiePair(response: Response, name: string): string {
  const line = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  assert.ok(line, name);
  assert.match(line, /HttpOnly/i);
  return line.split(";")[0] ?? "";
}

async function seedItinerary() {
  const db = await createMigratedDatabase();
  await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'a@example.com'), ($2, 'b@example.com')`, [
    USER_A,
    USER_B,
  ]);
  const saved = await savePlan(
    db,
    {
      rawText: REQUEST_TEXT,
      intent: { partySize: 2, area: "West Village" },
      options: [{ optionIndex: 0, option: OPTION_A }],
      ...META,
    },
    HASH_SECRET,
  );
  assert.ok(saved);
  const itineraryId = saved.itineraryIds[0];
  assert.ok(itineraryId);
  return { db, itineraryId };
}

function authFor(token: string, userId: string): MagicLinkAuth {
  return {
    async startMagicLink() {
      return true;
    },
    async exchangeCode(code, verifier) {
      return code === "good-code" && verifier.length >= 20 ? token : null;
    },
    async verifyTokenHash() {
      return null;
    },
    async userIdForAccessToken(accessToken) {
      return accessToken === token ? userId : null;
    },
  };
}

describe("save and share", () => {
  it("saves an anonymous itinerary for the signed-in user and returns the same slug again", async () => {
    const { db, itineraryId } = await seedItinerary();
    const auth = authFor("token-a", USER_A);
    const start = await createMagicLinkHandler(auth, memoryStore())(post("http://localhost/api/auth/magic-link", { email: "A@Example.com" }));
    const started = await start.json();
    assert.equal(start.status, 200);
    assert.deepEqual(started, { status: "sent" });
    assert.equal(JSON.stringify(started).includes("token-a"), false);

    const confirm = await createConfirmHandler(auth)(
      new Request("http://localhost/auth/confirm?code=good-code", {
        headers: { cookie: cookiePair(start, "nightcap_pkce") },
      }),
    );
    assert.equal(confirm.status, 303);
    assert.equal(await confirm.text(), "");
    const session = cookiePair(confirm, "nightcap_session");
    assert.equal(session.includes("token-a"), true);

    const save = createSavePlanHandler({
      db,
      userId: (request) => userIdFromRequest(request, auth),
    });
    const first = await save(post("http://localhost/api/saved-plans", { itineraryId }, session));
    const firstBody = await first.json();
    assert.equal(first.status, 201);
    assert.equal(firstBody.shareSlug.length, 32);
    assert.equal(isShareSlug(firstBody.shareSlug), true);
    assert.equal(firstBody.sharePath, `/s/${firstBody.shareSlug}`);

    const second = await save(post("http://localhost/api/saved-plans", { itineraryId }, session));
    const secondBody = await second.json();
    assert.equal(second.status, 200);
    assert.equal(secondBody.shareSlug, firstBody.shareSlug);

    const rows = await db.query<{ share_slug: string }>(`SELECT share_slug FROM public.saved_plans`);
    assert.deepEqual(
      rows.rows.map((row) => row.share_slug),
      [firstBody.shareSlug],
    );

    const sessionView = await createSessionHandler(auth)(
      new Request("http://localhost/api/auth/session", { headers: { cookie: session } }),
    );
    assert.equal(sessionView.status, 200);
    assert.deepEqual(await sessionView.json(), { signedIn: true });
  });

  it("refuses a client slug and a save with no itinerary id", async () => {
    const { db, itineraryId } = await seedItinerary();
    const save = createSavePlanHandler({
      db,
      userId: async () => USER_A,
    });
    const chosen = await save(
      post("http://localhost/api/saved-plans", { itineraryId, shareSlug: "client-picked-slug" }),
    );
    assert.equal(chosen.status, 400);
    assert.deepEqual(await chosen.json(), { error: "client_slug" });

    const missing = await save(post("http://localhost/api/saved-plans", {}));
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), { error: "invalid_request" });

    const unsigned = await createSavePlanHandler({
      db,
      userId: async () => null,
    })(post("http://localhost/api/saved-plans", { itineraryId }));
    assert.equal(unsigned.status, 401);
    assert.deepEqual(await unsigned.json(), { error: "sign_in_required" });

    const rows = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM public.saved_plans`);
    assert.equal(rows.rows[0]?.count, "0");
  });

  it("refuses a missing itinerary and another user's itinerary", async () => {
    const { db, itineraryId } = await seedItinerary();
    const save = createSavePlanHandler({
      db,
      userId: async () => USER_A,
    });
    const missing = await save(post("http://localhost/api/saved-plans", { itineraryId: MISSING }));
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "not_found" });

    await db.query(
      `UPDATE public.requests SET user_id = $1 WHERE id = (SELECT request_id FROM public.itineraries WHERE id = $2)`,
      [USER_B, itineraryId],
    );
    const forbidden = await save(post("http://localhost/api/saved-plans", { itineraryId }));
    assert.equal(forbidden.status, 403);
    assert.deepEqual(await forbidden.json(), { error: "forbidden" });

    const rows = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM public.saved_plans`);
    assert.equal(rows.rows[0]?.count, "0");
  });

  it("hydrates names for an exact slug and returns not found for a pattern", async () => {
    const { db, itineraryId } = await seedItinerary();
    const save = createSavePlanHandler({ db, userId: async () => USER_A });
    const saved = await save(post("http://localhost/api/saved-plans", { itineraryId }));
    const { shareSlug } = await saved.json();
    const lookup: PlaceDetailsLookup = {
      async lookup(placeIds) {
        return new Map(
          placeIds.map((placeId) => [
            placeId,
            { placeId, name: `Live ${placeId}`, formattedAddress: "1 Grove St", rating: 4.5, priceLevel: null },
          ]),
        );
      },
    };
    const read = createSharedPlanHandler({
      db,
      lookup,
      placesBlocked: async () => false,
    });
    const found = await read(shareSlug);
    const body = await found.json();
    assert.equal(found.status, 200);
    assert.equal(body.hydrated, true);
    assert.equal(body.itineraryId, itineraryId);
    assert.equal(body.stops[0].name, `Live ${body.storedStops[0].placeId}`);
    assert.equal(Object.hasOwn(body.storedStops[0], "name"), false);
    assert.equal(body.storedStops[0].placeId, body.stops[0].placeId);

    const probe = `${shareSlug}%`;
    const sql = await db.query(`SELECT * FROM public.get_shared_plan($1)`, [probe]);
    assert.equal(sql.rows.length, 0);
    const missed = await read(probe);
    assert.equal(missed.status, 404);
    assert.deepEqual(await missed.json(), { error: "not_found" });

    const samples: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const started = performance.now();
      const timed = await read(shareSlug);
      const timedBody = await timed.json();
      samples.push(performance.now() - started);
      assert.equal(timedBody.stops[0].name, `Live ${body.storedStops[0].placeId}`);
    }
    samples.sort((left, right) => left - right);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1] ?? 2000;
    console.info(`share hydrate p95 ${p95.toFixed(1)} ms`);
    assert.equal(p95 < 2000, true, `share hydrate p95 ${p95.toFixed(1)} ms`);

    const blocked = await createSharedPlanHandler({
      db,
      lookup,
      placesBlocked: async () => true,
    })(shareSlug);
    const capped = await blocked.json();
    assert.equal(blocked.status, 200);
    assert.equal(capped.hydrated, false);
    assert.equal(capped.stops[0].name, null);
    assert.equal(capped.stops[0].placeId, body.storedStops[0].placeId);
  });

  it("asks GoTrue for a magic link without a captcha token", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as unknown;
      calls.push({ url, body });
      if (url.includes("/otp")) return new Response("{}", { status: 200 });
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    try {
      const auth = createGoTrueAuth({
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_ANON_KEY: "anon-test",
      });
      assert.ok(auth);
      const response = await createMagicLinkHandler(auth, memoryStore())(
        post("http://localhost/api/auth/magic-link", { email: "ada@example.com" }),
      );
      assert.equal(response.status, 200);
      const sent = await response.json();
      assert.deepEqual(sent, { status: "sent" });
      assert.equal(calls.length, 1);
      const call = calls[0];
      assert.ok(call);
      assert.equal(call.url.startsWith("https://example.supabase.co/auth/v1/otp?redirect_to="), true);
      assert.equal(call.url.includes(encodeURIComponent("http://localhost/auth/confirm")), true);
      assert.deepEqual(Object.keys(call.body as object).sort(), [
        "code_challenge",
        "code_challenge_method",
        "create_user",
        "data",
        "email",
      ]);
      assert.equal(JSON.stringify(call.body).includes("captcha"), false);
      const verifier = readCookie(
        new Request("http://localhost/", { headers: { cookie: cookiePair(response, "nightcap_pkce") } }),
        "nightcap_pkce",
      );
      assert.equal(verifier !== null && verifier.length >= 20, true);
      assert.equal(JSON.stringify(sent).includes(verifier ?? "missing"), false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("exchanges a code and reads the user id, and rejects a bad sign-in link", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as { type?: string; auth_code?: string };
      if (url.includes("/token") && body.auth_code === "good-code") {
        return Response.json({ access_token: "tok-live" });
      }
      if (url.includes("/verify") && body.type === "magiclink") {
        return Response.json({ access_token: "tok-hash" });
      }
      if (url.includes("/user")) {
        const header = new Headers(init?.headers).get("authorization");
        if (header === "Bearer tok-live") return Response.json({ id: USER_A });
        return new Response("no", { status: 401 });
      }
      return new Response("no", { status: 400 });
    }) as typeof fetch;
    try {
      const auth = createGoTrueAuth({
        SUPABASE_URL: "https://example.supabase.co/",
        SUPABASE_PUBLISHABLE_KEY: "pub-test",
      });
      assert.ok(auth);
      assert.equal(await auth.exchangeCode("good-code", "verifier-verifier-verifier"), "tok-live");
      assert.equal(await auth.exchangeCode("bad-code", "verifier-verifier-verifier"), null);
      assert.equal(await auth.verifyTokenHash("hash", "magiclink"), "tok-hash");
      assert.equal(await auth.verifyTokenHash("hash", "sms"), null);
      assert.equal(await auth.userIdForAccessToken("tok-live"), USER_A);
      assert.equal(await auth.userIdForAccessToken("other"), null);

      const confirm = await createConfirmHandler(auth)(new Request("http://localhost/auth/confirm"));
      assert.equal(confirm.status, 400);
      assert.equal((await confirm.text()).includes("itinerary"), false);
      assert.equal(createGoTrueAuth({}), null);

      const unconfigured = await createMagicLinkHandler(null, memoryStore())(
        post("http://localhost/api/auth/magic-link", { email: "ada@example.com" }),
      );
      assert.equal(unconfigured.status, 503);
      assert.deepEqual(await unconfigured.json(), { error: "auth_unconfigured" });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reports a bad slug as not found before it looks for a database", async () => {
    assert.deepEqual(await loadSharedPlanPage("short"), { status: "missing" });
    const read = createProductionSharedPlanHandler();
    const missing = await read("not a slug");
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "not_found" });
    if (databaseUrl(process.env)) return;
    assert.deepEqual(await loadSharedPlanPage("abcdefghijklmnop"), { status: "unconfigured" });
    assert.equal((await read("abcdefghijklmnop")).status, 503);
    const save = await createProductionSaveHandler()(post("http://localhost/api/saved-plans", { itineraryId: MISSING }));
    assert.equal(save.status, 503);
    assert.deepEqual(await save.json(), { error: "persist_unconfigured" });
  });
});

describe("auth hardening", () => {
  it("treats a cookie with malformed percent-encoding as signed out", async () => {
    const request = new Request("http://localhost/api/auth/session", {
      headers: { cookie: "nightcap_session=%E0%A4%A" },
    });
    assert.equal(readCookie(request, "nightcap_session"), null);
    const response = await createSessionHandler(authFor("t", USER_A))(request);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { signedIn: false });
  });

  it("allows 5 magic links per IP per hour and rejects the 6th without calling GoTrue", async () => {
    let sends = 0;
    const auth: MagicLinkAuth = {
      ...authFor("t", USER_A),
      async startMagicLink() {
        sends += 1;
        return true;
      },
    };
    const handler = createMagicLinkHandler(auth, memoryStore());
    const send = () =>
      handler(
        new Request("http://localhost/api/auth/magic-link", {
          method: "POST",
          headers: { "x-forwarded-for": "203.0.113.9" },
          body: JSON.stringify({ email: "ada@example.com" }),
        }),
      );
    for (let i = 0; i < 5; i += 1) assert.equal((await send()).status, 200);
    const limited = await send();
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: "rate_limited" });
    assert.equal(sends, 5);
  });

  it("fails closed with 503 when the rate-limit store throws", async () => {
    const store = { ...memoryStore(), async recordPlan(): Promise<number> { throw new Error("down"); } };
    const response = await createMagicLinkHandler(authFor("t", USER_A), store)(
      post("http://localhost/api/auth/magic-link", { email: "ada@example.com" }),
    );
    assert.equal(response.status, 503);
  });
});
