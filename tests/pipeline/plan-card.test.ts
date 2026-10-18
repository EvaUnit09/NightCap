import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildPlanBrief,
  expandPlanCard,
  parsePlanCard,
} from "../../src/pipeline/plan-card";
import type { Candidate } from "../../src/validation/candidate";
import type { Intent } from "../../src/validation/intent";
import type { TravelCalculator } from "../../src/validation/travel";

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

describe("plan-card", () => {
  it("parses refs and expands into a schedulable itinerary", async () => {
    const brief = buildPlanBrief(POOL);
    const parsed = parsePlanCard(
      {
        options: [
          {
            theme: "First night",
            stops: [
              { ref: "0", why: "Dinner pick" },
              { ref: "2", why: "Drinks pick" },
            ],
          },
          {
            theme: "Second night",
            stops: [
              { ref: "1", why: "Alt dinner" },
              { ref: "3", why: "Alt drinks" },
            ],
          },
        ],
      },
      brief,
      INTENT,
    );
    assert.equal(parsed.success, true);
    if (!parsed.success) {
      return;
    }
    const expanded = await expandPlanCard({
      card: parsed.data,
      brief,
      intent: INTENT,
      travel: TRAVEL,
      maxLegs: 6,
    });
    assert.equal(expanded.kind, "ready");
    if (expanded.kind !== "ready") {
      return;
    }
    assert.equal(expanded.itinerary.options.length, 2);
    const ids = expanded.itinerary.options.flatMap((option) => option.stops.map((stop) => stop.placeId));
    assert.deepEqual(ids, ["ChIJ_d1", "ChIJ_r1", "ChIJ_d2", "ChIJ_r2"]);
  });

  it("rejects unknown refs", () => {
    const brief = buildPlanBrief(POOL);
    const parsed = parsePlanCard(
      {
        options: [
          {
            theme: "Bad",
            stops: [
              { ref: "99", why: "missing" },
              { ref: "2", why: "ok" },
            ],
          },
          {
            theme: "Also bad",
            stops: [
              { ref: "1", why: "ok" },
              { ref: "3", why: "ok" },
            ],
          },
        ],
      },
      brief,
      INTENT,
    );
    assert.equal(parsed.success, false);
  });
});
