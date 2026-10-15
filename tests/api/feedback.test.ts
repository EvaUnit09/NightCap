import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createFeedbackHandler } from "../../src/api/feedback";
import { createPlanHandler } from "../../src/api/plan-stream";
import { resetConfig } from "../../src/models";
import { hashRequest, savePlan, stripStopForStorage } from "../../src/monitoring";
import { usdToMicros, spendDay } from "../../src/monitoring/spend-cap";
import { createSpendStoreFromEnv } from "../../src/monitoring/spend-store";
import { OPTION_A, REQUEST_TEXT } from "../pipeline/orchestrator-harness";
import { createMigratedDatabase } from "../migrations/harness";

const HASH_SECRET = "test-hash-secret";
const RAW = "Book a table for ada@example.com";
const NOW = Date.UTC(2026, 9, 12, 22, 0, 0);
const MISSING_ITINERARY = "22222222-2222-4222-8222-222222222222";

const META = {
  promptVersions: { parse_intent: "v1", plan_itineraries: "v1", repair_itinerary: "v1" },
  models: { parse_intent: "claude-haiku-5-5", plan_itineraries: "claude-haiku-5-5" },
  costUsd: 0.012,
  latencyMs: 40,
} as const;

function post(body: unknown): Request {
  return new Request("http://localhost/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function savedItinerary() {
  const db = await createMigratedDatabase();
  const saved = await savePlan(
    db,
    {
      rawText: RAW,
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

describe("POST /api/feedback", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetConfig();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
  });

  it("stores thumbs down with the itinerary id and the Datadog request hash", async () => {
    const { db, itineraryId } = await savedItinerary();
    try {
      const handler = createFeedbackHandler(db);
      const response = await handler(post({ itineraryId, signal: { kind: "thumbs", thumbs: -1 } }));
      const body = await response.json();

      assert.equal(response.status, 201);
      assert.equal(body.itineraryId, itineraryId);
      assert.equal(body.requestHash, hashRequest(RAW, HASH_SECRET));

      const rows = await db.query<{
        itinerary_id: string;
        thumbs: number;
        request_hash: string;
        client_hash: string;
      }>(
        `SELECT f.itinerary_id, f.thumbs, f.request_hash, r.client_hash
         FROM public.feedback AS f
         JOIN public.itineraries AS i ON i.id = f.itinerary_id
         JOIN public.requests AS r ON r.id = i.request_id`,
      );
      assert.equal(rows.rows.length, 1);
      assert.equal(rows.rows[0].itinerary_id, itineraryId);
      assert.equal(rows.rows[0].thumbs, -1);
      assert.equal(rows.rows[0].request_hash, rows.rows[0].client_hash);
      assert.equal(rows.rows[0].request_hash, hashRequest(RAW, HASH_SECRET));
    } finally {
      await db.close();
    }
  });

  it("stores would-go, did-go, new-to-you, and a closed place on that itinerary", async () => {
    const { db, itineraryId } = await savedItinerary();
    try {
      const handler = createFeedbackHandler(db);
      const would = await handler(post({ itineraryId, signal: { kind: "would_go", wouldGo: true } }));
      const did = await handler(post({ itineraryId, signal: { kind: "did_go", didGo: false } }));
      const fresh = await handler(
        post({ itineraryId, signal: { kind: "new_to_you", placeId: "ChIJbar0", value: true } }),
      );
      const closed = await handler(post({ itineraryId, signal: { kind: "closed_venue", placeId: "ChIJdin0" } }));

      assert.equal(would.status, 201);
      assert.equal(did.status, 201);
      assert.equal(fresh.status, 201);
      assert.equal(closed.status, 201);

      const rows = await db.query<{
        would_go: boolean | null;
        did_go: boolean | null;
        new_to_you: { ChIJbar0?: boolean } | null;
        closed_report_place_id: string | null;
      }>(
        `SELECT would_go, did_go, new_to_you, closed_report_place_id
         FROM public.feedback
         ORDER BY created_at, ctid`,
      );
      assert.deepEqual(
        rows.rows.map((row) => ({
          would_go: row.would_go,
          did_go: row.did_go,
          new_to_you: row.new_to_you,
          closed_report_place_id: row.closed_report_place_id,
        })),
        [
          { would_go: true, did_go: null, new_to_you: null, closed_report_place_id: null },
          { would_go: null, did_go: false, new_to_you: null, closed_report_place_id: null },
          { would_go: null, did_go: null, new_to_you: { ChIJbar0: true }, closed_report_place_id: null },
          { would_go: null, did_go: null, new_to_you: null, closed_report_place_id: "ChIJdin0" },
        ],
      );
    } finally {
      await db.close();
    }
  });

  it("replays the same signal as one row", async () => {
    const { db, itineraryId } = await savedItinerary();
    try {
      const handler = createFeedbackHandler(db);
      const body = { itineraryId, signal: { kind: "thumbs", thumbs: 1 } };
      const first = await handler(post(body));
      const second = await handler(post(body));
      const firstBody = await first.json();
      const secondBody = await second.json();

      assert.equal(first.status, 201);
      assert.equal(second.status, 200);
      assert.equal(secondBody.id, firstBody.id);
      const count = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM public.feedback`);
      assert.equal(Number(count.rows[0].n), 1);
    } finally {
      await db.close();
    }
  });

  it("rejects a closed report for a place that is not on the itinerary and writes nothing", async () => {
    const { db, itineraryId } = await savedItinerary();
    try {
      const handler = createFeedbackHandler(db);
      const response = await handler(
        post({ itineraryId, signal: { kind: "closed_venue", placeId: "ChIJmissing" } }),
      );
      assert.equal(response.status, 422);
      assert.deepEqual(await response.json(), { error: "unknown_place" });
      const count = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM public.feedback`);
      assert.equal(Number(count.rows[0].n), 0);
    } finally {
      await db.close();
    }
  });

  it("rejects an unknown itinerary and a body that adds a captcha field", async () => {
    const { db, itineraryId } = await savedItinerary();
    try {
      const handler = createFeedbackHandler(db);
      const missing = await handler(post({ itineraryId: MISSING_ITINERARY, signal: { kind: "thumbs", thumbs: 1 } }));
      assert.equal(missing.status, 404);
      assert.deepEqual(await missing.json(), { error: "not_found" });

      const captcha = await handler(
        post({ itineraryId, signal: { kind: "thumbs", thumbs: 1 }, turnstileToken: "skip" }),
      );
      assert.equal(captcha.status, 400);
      assert.deepEqual(await captcha.json(), { error: "invalid_request" });

      const count = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM public.feedback`);
      assert.equal(Number(count.rows[0].n), 0);
    } finally {
      await db.close();
    }
  });

  it("does not store feedback when the request hash cannot join to Datadog", async () => {
    const db = await createMigratedDatabase();
    try {
      const request = await db.query<{ id: string }>(
        `INSERT INTO public.requests (redacted_text, parsed_intent, client_hash)
         VALUES ('a night out', '{"area":"West Village"}'::jsonb, NULL)
         RETURNING id`,
      );
      const requestId = request.rows[0]?.id;
      assert.ok(requestId);
      const stop = stripStopForStorage(OPTION_A.stops[0]);
      const itinerary = await db.query<{ id: string }>(
        `INSERT INTO public.itineraries (request_id, option_index, stops, prompt_versions, models)
         VALUES ($1, 0, $2::jsonb, '{}'::jsonb, '{}'::jsonb)
         RETURNING id`,
        [requestId, JSON.stringify([stop])],
      );
      const itineraryId = itinerary.rows[0]?.id;
      assert.ok(itineraryId);
      const response = await createFeedbackHandler(db)(post({ itineraryId, signal: { kind: "thumbs", thumbs: 1 } }));
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: "unjoinable" });
      const count = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM public.feedback`);
      assert.equal(Number(count.rows[0].n), 0);
    } finally {
      await db.close();
    }
  });

  it("leaves feedback empty when the daily cap refuses the plan", async () => {
    const db = await createMigratedDatabase();
    try {
      const store = createSpendStoreFromEnv({});
      await store.addDailyMicros(spendDay(NOW), usdToMicros(5));
      let saves = 0;
      const plan = createPlanHandler(
        () => {
          throw new Error("pipeline must not start");
        },
        {
          store,
          now: () => NOW,
          persist: {
            async save() {
              saves += 1;
              return { requestId: MISSING_ITINERARY, itineraryIds: [MISSING_ITINERARY] };
            },
          },
        },
      );
      const response = await plan(
        new Request("http://localhost/api/plan", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
          body: JSON.stringify({ text: REQUEST_TEXT }),
        }),
      );
      assert.equal(response.status, 429);
      assert.equal(saves, 0);
      const feedbackResponse = await createFeedbackHandler(db)(
        post({ itineraryId: MISSING_ITINERARY, signal: { kind: "thumbs", thumbs: -1 } }),
      );
      assert.equal(feedbackResponse.status, 404);
      const feedback = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM public.feedback`);
      const requests = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM public.requests`);
      assert.equal(Number(feedback.rows[0].n), 0);
      assert.equal(Number(requests.rows[0].n), 0);
    } finally {
      await db.close();
    }
  });
});
