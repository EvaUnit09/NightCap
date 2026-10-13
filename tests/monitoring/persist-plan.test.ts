import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { savePlan, stripStopForStorage } from "../../src/monitoring";
import { OPTION_A, OPTION_B } from "../pipeline/orchestrator-harness";
import { createMigratedDatabase, expectRejects } from "../migrations/harness";

const HASH_SECRET = "test-hash-secret";
const RAW = "Book a table for ada@example.com";

const META = {
  promptVersions: { parse_intent: "v1", plan_itineraries: "v1", repair_itinerary: "v1" },
  models: { parse_intent: "claude-haiku-5-5", plan_itineraries: "claude-haiku-5-5" },
  costUsd: 0.012,
  latencyMs: 40,
} as const;

describe("stripStopForStorage", () => {
  it("drops the venue name before a stop can be stored", () => {
    const stored = stripStopForStorage(OPTION_A.stops[0]);
    assert.deepEqual(Object.keys(stored).sort(), ["end", "estimatedCostUsd", "placeId", "start", "travelToNext", "why"]);
    assert.equal(JSON.stringify(stored).includes("Little Branch"), false);
    assert.equal(JSON.stringify(stored).includes("name"), false);
    assert.equal(stored.placeId, "ChIJbar0");
  });
});

describe("savePlan", () => {
  it("reloads placeIds and rejects a stop that still has a name", async () => {
    const db = await createMigratedDatabase();
    try {
      const saved = await savePlan(
        db,
        {
          rawText: RAW,
          intent: { partySize: 2, area: "West Village" },
          options: [
            { optionIndex: 0, option: OPTION_A },
            { optionIndex: 1, option: OPTION_B },
          ],
          ...META,
        },
        HASH_SECRET,
      );
      assert.ok(saved);
      if (!saved) return;

      const stops = await db.query<{ stops: unknown }>(
        `SELECT stops FROM public.itineraries WHERE request_id = $1 ORDER BY option_index`,
        [saved.requestId],
      );
      assert.equal(stops.rows.length, 2);
      const wire = JSON.stringify(stops.rows);
      assert.equal(wire.includes("Little Branch"), false);
      assert.equal(wire.includes("Via Carota"), false);
      assert.equal(wire.includes("\"name\""), false);
      assert.equal(wire.includes("ChIJbar0"), true);

      const meta = await db.query<{ prompt_versions: { parse_intent: string }; models: { plan_itineraries: string }; cost_usd: string; latency_ms: number }>(
        `SELECT prompt_versions, models, cost_usd, latency_ms FROM public.itineraries WHERE id = $1`,
        [saved.itineraryIds[0]],
      );
      assert.equal(meta.rows[0].prompt_versions.parse_intent, "v1");
      assert.equal(meta.rows[0].models.plan_itineraries, "claude-haiku-5-5");
      assert.equal(Number.isFinite(Number(meta.rows[0].cost_usd)), true);
      assert.equal(Number.isFinite(meta.rows[0].latency_ms), true);

      await expectRejects(
        () =>
          db.query(
            `INSERT INTO public.itineraries (
               request_id, option_index, stops, valid, prompt_versions, models
             ) VALUES ($1, 2, $2::jsonb, true, '{}'::jsonb, '{}'::jsonb)`,
            [saved.requestId, JSON.stringify([{ ...stripStopForStorage(OPTION_A.stops[0]), name: "Little Branch" }])],
          ),
        /itineraries_stops_place_ids_only|place_ids_only|check constraint/i,
      );
    } finally {
      await db.close();
    }
  });

  it("stores the redacted request when parse succeeded and no option finished", async () => {
    const db = await createMigratedDatabase();
    try {
      const saved = await savePlan(
        db,
        { rawText: RAW, intent: { partySize: 2 }, options: [], ...META },
        HASH_SECRET,
      );
      assert.ok(saved);
      if (!saved) return;
      assert.deepEqual(saved.itineraryIds, []);
      const requests = await db.query<{ redacted_text: string }>(`SELECT redacted_text FROM public.requests WHERE id = $1`, [
        saved.requestId,
      ]);
      assert.equal(requests.rows[0].redacted_text, "Book a table for [EMAIL]");
      const itineraries = await db.query(`SELECT id FROM public.itineraries WHERE request_id = $1`, [saved.requestId]);
      assert.equal(itineraries.rows.length, 0);
    } finally {
      await db.close();
    }
  });

  it("writes nothing when parse never produced an intent", async () => {
    const db = await createMigratedDatabase();
    try {
      const saved = await savePlan(db, { rawText: RAW, intent: null, options: [], ...META }, HASH_SECRET);
      assert.equal(saved, null);
      const requests = await db.query(`SELECT id FROM public.requests`);
      assert.equal(requests.rows.length, 0);
    } finally {
      await db.close();
    }
  });
});
