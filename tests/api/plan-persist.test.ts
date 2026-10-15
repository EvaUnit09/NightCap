import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPlanHandler } from "../../src/api/plan-stream";
import { createSavePlanHandler } from "../../src/api/share";
import { createItineraryViewHandler } from "../../src/api/itinerary-view";
import { resetConfig } from "../../src/models";
import { createPlanPersistence, loadStoredItinerary, type PlaceDetailsLookup } from "../../src/monitoring";
import { usdToMicros, utcDay } from "../../src/monitoring/spend-cap";
import { createSpendStoreFromEnv } from "../../src/monitoring/spend-store";
import { INTENT, OPTION_A, OPTION_B, REQUEST_TEXT, fakeModels, harness } from "../pipeline/orchestrator-harness";
import { createMigratedDatabase } from "../migrations/harness";

const HASH_SECRET = "test-hash-secret";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const NOW = Date.UTC(2026, 9, 12, 22, 0, 0);

function post(body: unknown): Request {
  return new Request("http://localhost/api/plan", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.8" },
    body: JSON.stringify(body),
  });
}

describe("plan persist and hydrate view", () => {
  it("keeps venue names on the stream and stores placeIds only", async () => {
    resetConfig();
    const db = await createMigratedDatabase();
    try {
      const handler = createPlanHandler(() => harness({
        models: fakeModels({
          parse_intent: [{ json: INTENT }],
          plan_itineraries: [{ json: { options: [OPTION_A, OPTION_B] } }],
        }),
      }).deps, {
        persist: createPlanPersistence(db, HASH_SECRET),
      });
      const response = await handler(post({ text: REQUEST_TEXT }));
      const wire = await response.text();
      assert.equal(response.status, 200);
      assert.match(wire, /Little Branch/);
      assert.match(wire, /event: done/);

      const rows = await db.query<{ stops: unknown }>(`SELECT stops FROM public.itineraries`);
      assert.equal(rows.rows.length, 2);
      const stored = JSON.stringify(rows.rows);
      assert.equal(stored.includes("Little Branch"), false);
      assert.equal(stored.includes("\"name\""), false);
      assert.equal(stored.includes("ChIJbar0"), true);
    } finally {
      await db.close();
    }
  });

  it("does not insert a request when the daily cap refuses the plan", async () => {
    resetConfig();
    const db = await createMigratedDatabase();
    try {
      const store = createSpendStoreFromEnv({});
      await store.addDailyMicros(utcDay(NOW), usdToMicros(5));
      let saves = 0;
      const handler = createPlanHandler(
        () => {
          throw new Error("pipeline must not start");
        },
        {
          store,
          now: () => NOW,
          persist: {
            async save() {
              saves += 1;
              return null;
            },
          },
        },
      );
      const response = await handler(post({ text: REQUEST_TEXT }));
      assert.equal(response.status, 429);
      assert.equal(saves, 0);
      const requests = await db.query(`SELECT id FROM public.requests`);
      assert.equal(requests.rows.length, 0);
    } finally {
      await db.close();
    }
  });

  it("hydrates names on the view and skips Places when the daily cap is already spent", async () => {
    resetConfig();
    const db = await createMigratedDatabase();
    try {
      const saved = await createPlanPersistence(db, HASH_SECRET).save({
        rawText: "drinks then dinner",
        intent: { area: "West Village" },
        options: [{ optionIndex: 0, option: OPTION_A }],
        promptVersions: { parse_intent: "v1", plan_itineraries: "v1", repair_itinerary: "v1" },
        models: { parse_intent: "claude-haiku-5-5", plan_itineraries: "claude-haiku-5-5" },
        costUsd: 0.01,
        latencyMs: 8,
      });
      assert.ok(saved);
      if (!saved) return;
      const id = saved.itineraryIds[0];
      let lookups = 0;
      const lookup: PlaceDetailsLookup = {
        async lookup() {
          lookups += 1;
          return new Map([
            ["ChIJbar0", { placeId: "ChIJbar0", name: "Little Branch", formattedAddress: null, rating: null, priceLevel: null }],
            ["ChIJdin0", { placeId: "ChIJdin0", name: "Via Carota", formattedAddress: null, rating: null, priceLevel: null }],
          ]);
        },
      };
      const open = createItineraryViewHandler({
        load: (itineraryId) => loadStoredItinerary(db, itineraryId),
        lookup,
        placesBlocked: async () => false,
      });
      const body = await (await open(new Request("http://localhost/"), id)).json();
      assert.equal(body.hydrated, true);
      assert.equal(body.stops[0].name, "Little Branch");
      assert.equal(JSON.stringify(body.storedStops).includes("Little Branch"), false);
      assert.equal(lookups, 1);

      const blocked = createItineraryViewHandler({
        load: (itineraryId) => loadStoredItinerary(db, itineraryId),
        lookup,
        placesBlocked: async () => true,
      });
      const capped = await (await blocked(new Request("http://localhost/"), id)).json();
      assert.equal(capped.hydrated, false);
      assert.equal(capped.stops[0].name, null);
      assert.equal(lookups, 1);
    } finally {
      await db.close();
    }
  });

  it("persists the signed-in user so another user cannot save the plan", async () => {
    resetConfig();
    const db = await createMigratedDatabase();
    try {
      await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'a@example.com'), ($2, 'b@example.com')`, [USER_A, USER_B]);
      const handler = createPlanHandler(() => harness({
        models: fakeModels({
          parse_intent: [{ json: INTENT }, { json: INTENT }],
          plan_itineraries: [{ json: { options: [OPTION_A, OPTION_B] } }, { json: { options: [OPTION_A, OPTION_B] } }],
        }),
      }).deps, {
        persist: createPlanPersistence(db, HASH_SECRET),
        userId: async (request) => (request.headers.get("cookie") === "session=a" ? USER_A : null),
      });
      const signedIn = new Request("http://localhost/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "session=a" },
        body: JSON.stringify({ text: REQUEST_TEXT }),
      });
      const wire = await (await handler(signedIn)).text();
      const itineraryId = /"itineraryIds":\["([^"]+)"/.exec(wire)?.[1];
      assert.ok(itineraryId, wire);
      await (await handler(post({ text: REQUEST_TEXT }))).text();

      const owners = await db.query<{ user_id: string | null }>(`SELECT user_id FROM public.requests ORDER BY created_at`);
      assert.deepEqual(owners.rows.map((row) => row.user_id), [USER_A, null]);

      const saveAs = (userId: string) =>
        createSavePlanHandler({ db, userId: async () => userId })(
          new Request("http://localhost/api/saved-plans", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ itineraryId }),
          }),
        );
      assert.equal((await saveAs(USER_B)).status, 403);
      assert.equal((await saveAs(USER_A)).status, 201);
    } finally {
      await db.close();
    }
  });
});
