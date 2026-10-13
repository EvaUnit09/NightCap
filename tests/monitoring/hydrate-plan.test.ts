import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hydrateItinerary, loadStoredItinerary, savePlan, type PlaceDetailsLookup } from "../../src/monitoring";
import { OPTION_A } from "../pipeline/orchestrator-harness";
import { createMigratedDatabase } from "../migrations/harness";

const HASH_SECRET = "test-hash-secret";

describe("hydrateItinerary", () => {
  it("loads placeIds from Postgres and attaches live names only on the view", async () => {
    const db = await createMigratedDatabase();
    try {
      const saved = await savePlan(
        db,
        {
          rawText: "drinks then dinner",
          intent: { area: "West Village" },
          options: [{ optionIndex: 0, option: OPTION_A }],
          promptVersions: { parse_intent: "v1", plan_itineraries: "v1", repair_itinerary: "v1" },
          models: { parse_intent: "claude-haiku-5-5", plan_itineraries: "claude-haiku-5-5" },
          costUsd: 0.004,
          latencyMs: 12,
        },
        HASH_SECRET,
      );
      assert.ok(saved);
      if (!saved) return;

      const stored = await loadStoredItinerary(db, saved.itineraryIds[0]);
      assert.ok(stored);
      if (!stored) return;
      assert.deepEqual(
        stored.stops.map((stop) => stop.placeId),
        ["ChIJbar0", "ChIJdin0"],
      );
      assert.equal(JSON.stringify(stored.stops).includes("Little Branch"), false);

      const lookup: PlaceDetailsLookup = {
        async lookup(placeIds) {
          assert.deepEqual([...placeIds], ["ChIJbar0", "ChIJdin0"]);
          return new Map([
            ["ChIJbar0", { placeId: "ChIJbar0", name: "Little Branch", formattedAddress: "20 7th Ave", rating: 4.4, priceLevel: "PRICE_LEVEL_MODERATE" }],
            ["ChIJdin0", { placeId: "ChIJdin0", name: "Via Carota", formattedAddress: null, rating: null, priceLevel: null }],
          ]);
        },
      };
      const view = await hydrateItinerary(stored, lookup);
      assert.equal(view.stops[0].name, "Little Branch");
      assert.equal(view.stops[0].formattedAddress, "20 7th Ave");
      assert.equal(view.stops[1].name, "Via Carota");
      assert.equal(JSON.stringify(view.itinerary.stops).includes("Little Branch"), false);
    } finally {
      await db.close();
    }
  });
});
