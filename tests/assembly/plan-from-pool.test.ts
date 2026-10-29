import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planFromPool } from "../../src/assembly/plan-from-pool";
import type { Candidate } from "../../src/validation/candidate";
import type { Intent } from "../../src/validation/intent";
import type { TravelCalculator } from "../../src/validation/travel";
import { validateItinerary } from "../../src/validation/validator";

const TRAVEL: TravelCalculator = { calculateMinutes: (legs) => legs.map(() => 8) };

const INTENT: Intent = {
  area: "West Village",
  window: { start: "2026-10-16T19:00:00-04:00", end: "2026-10-16T23:30:00-04:00" },
  budgetUsd: 200,
  dietary: [],
  vibeTags: ["cozy"],
  stopTypes: ["dinner", "drinks"],
  singleStop: false,
};

function openHours(): Candidate["openingHours"] {
  return Array.from({ length: 7 }, (_, day) => ({
    open: { day, hour: 17, minute: 0 },
    close: { day, hour: 23, minute: 0 },
  }));
}

function candidate(placeId: string, stopType: Candidate["stopType"], name: string, lat: number): Candidate {
  return {
    placeId,
    name,
    stopType,
    businessStatus: "OPERATIONAL",
    priceLevel: "PRICE_LEVEL_MODERATE",
    rating: 4.4,
    reviewCount: 400,
    location: { lat, lng: -74.0 },
    openingHours: openHours(),
    types: [stopType === "dinner" ? "restaurant" : "bar"],
  };
}

const POOL: Candidate[] = [
  candidate("ChIJ_d1", "dinner", "Dinner One", 40.73),
  candidate("ChIJ_d2", "dinner", "Dinner Two", 40.731),
  candidate("ChIJ_r1", "drinks", "Drinks One", 40.732),
  candidate("ChIJ_r2", "drinks", "Drinks Two", 40.733),
];

describe("planFromPool", () => {
  it("admits two disjoint pooled options when the model throws", async () => {
    const result = await planFromPool({
      intent: INTENT,
      candidates: POOL,
      models: {
        async complete() {
          throw new Error("narration unavailable");
        },
      },
      travel: TRAVEL,
      validate: (input, travel) => validateItinerary(input, { travelCalculator: travel, maxLegs: 6 }),
      maxLegs: 6,
      narratePromptVersion: "v1",
    });

    assert.equal(result.kind, "ready");
    if (result.kind !== "ready") {
      return;
    }
    assert.equal(result.narration, "template");
    assert.ok(result.emitted.length >= 2);
    const ids = result.emitted.flatMap(({ option }) => option.stops.map((stop) => stop.placeId));
    assert.equal(new Set(ids).size, ids.length);
    const poolIds = new Set(POOL.map((c) => c.placeId));
    assert.ok(ids.every((id) => poolIds.has(id)));
  });
});
