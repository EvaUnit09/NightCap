import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";

import { candidateSchema } from "../../src/validation/candidate";
import { intentSchema } from "../../src/validation/intent";
import type { TravelCalculator } from "../../src/validation/travel";
import { validationErrorSchema } from "../../src/validation/validation-error";
import { validateItinerary } from "../../src/validation/validator";

const THU_HOURS = [
  { open: { day: 4, hour: 17, minute: 0 }, close: { day: 4, hour: 23, minute: 0 } },
];

const intent: z.input<typeof intentSchema> = {
  area: "Manhattan",
  window: {
    start: "2026-10-15T19:00:00-04:00",
    end: "2026-10-15T23:00:00-04:00",
  },
  budgetUsd: 400,
  dietary: [],
  vibeTags: ["cozy"],
  stopTypes: ["drinks", "dinner"],
};

const singleStopIntent: z.input<typeof intentSchema> = {
  ...intent,
  stopTypes: ["drinks"],
  singleStop: true,
};

function candidate(
  placeId: string,
  name: string,
  overrides: Partial<z.input<typeof candidateSchema>> = {}
): z.input<typeof candidateSchema> {
  return {
    placeId,
    name,
    businessStatus: "OPERATIONAL",
    priceLevel: "PRICE_LEVEL_MODERATE",
    rating: 4.4,
    reviewCount: 80,
    location: { lat: 40.735 + placeId.length * 0.001, lng: -74.002 },
    openingHours: THU_HOURS,
    types: ["bar"],
    stopType: "drinks",
    ...overrides,
  };
}

function twoOptionPlan(overrides?: {
  costs?: [number, number, number, number];
  travelMinutes?: number;
}) {
  const costs = overrides?.costs ?? [40, 80, 40, 80];
  const minutes = overrides?.travelMinutes ?? 10;
  return {
    options: [
      {
        theme: "West Village",
        stops: [
          {
            placeId: "ChIJ1",
            name: "Venue One",
            start: "2026-10-15T19:00:00-04:00",
            end: "2026-10-15T20:00:00-04:00",
            estimatedCostUsd: costs[0],
            why: "Drinks",
            travelToNext: { mode: "WALK", minutes },
          },
          {
            placeId: "ChIJ2",
            name: "Venue Two",
            start: "2026-10-15T20:15:00-04:00",
            end: "2026-10-15T22:00:00-04:00",
            estimatedCostUsd: costs[1],
            why: "Dinner",
            travelToNext: null,
          },
        ],
      },
      {
        theme: "East Village",
        stops: [
          {
            placeId: "ChIJ3",
            name: "Venue Three",
            start: "2026-10-15T19:00:00-04:00",
            end: "2026-10-15T20:00:00-04:00",
            estimatedCostUsd: costs[2],
            why: "Drinks",
            travelToNext: { mode: "WALK", minutes },
          },
          {
            placeId: "ChIJ4",
            name: "Venue Four",
            start: "2026-10-15T20:15:00-04:00",
            end: "2026-10-15T22:00:00-04:00",
            estimatedCostUsd: costs[3],
            why: "Dinner",
            travelToNext: null,
          },
        ],
      },
    ],
  };
}

function fourCandidates(): Array<z.input<typeof candidateSchema>> {
  return [
    candidate("ChIJ1", "Venue One"),
    candidate("ChIJ2", "Venue Two", { stopType: "dinner" }),
    candidate("ChIJ3", "Venue Three"),
    candidate("ChIJ4", "Venue Four", { stopType: "dinner" }),
  ];
}

function setHopMode(
  itinerary: ReturnType<typeof twoOptionPlan>,
  mode: string
): void {
  itinerary.options[0]!.stops[0]!.travelToNext = {
    mode,
    minutes: 10,
  } as { mode: "WALK"; minutes: number };
}

function calc(minutes: number | null | (() => number | null)): TravelCalculator {
  return {
    calculateMinutes(legs) {
      return legs.map(() => (typeof minutes === "function" ? minutes() : minutes));
    },
  };
}

describe("validateItinerary", () => {
  it("passes a valid itinerary", async () => {
    const errors = await validateItinerary(
      { intent, candidates: fourCandidates(), itinerary: twoOptionPlan() },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.deepEqual(errors, []);
  });

  it("detects invented venues", async () => {
    const errors = await validateItinerary(
      {
        intent,
        candidates: fourCandidates().filter((c) => c.placeId !== "ChIJ2"),
        itinerary: twoOptionPlan(),
      },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.ok(errors.some((e) => e.code === "invented_venue" && e.placeId === "ChIJ2"));
    assert.ok(errors.every((e) => validationErrorSchema.safeParse(e).success));
  });

  it("detects non-operational venues", async () => {
    const candidates = fourCandidates();
    candidates[0] = { ...candidates[0]!, businessStatus: "CLOSED_PERMANENTLY" };
    const errors = await validateItinerary(
      { intent, candidates, itinerary: twoOptionPlan() },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.ok(errors.some((e) => e.code === "not_operational" && e.stopIndex === 0));
  });

  it("emits not_operational for FUTURE_OPENING", async () => {
    const candidates = fourCandidates();
    candidates[0] = {
      ...candidates[0]!,
      businessStatus: "FUTURE_OPENING",
      openingHours: [],
    };
    const errors = await validateItinerary(
      { intent, candidates, itinerary: twoOptionPlan() },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.ok(errors.some((e) => e.code === "not_operational"));
    assert.equal(errors.some((e) => e.code === "closed"), false);
  });

  it("detects closed venues", async () => {
    const candidates = fourCandidates();
    candidates[0] = {
      ...candidates[0]!,
      openingHours: [
        { open: { day: 4, hour: 12, minute: 0 }, close: { day: 4, hour: 17, minute: 0 } },
      ],
    };
    const errors = await validateItinerary(
      { intent, candidates, itinerary: twoOptionPlan() },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.ok(errors.some((e) => e.code === "closed" && e.optionIndex === 0));
  });

  it("treats only day 0 00:00 with no close as 24/7", async () => {
    const candidates = fourCandidates();
    candidates[0] = {
      ...candidates[0]!,
      openingHours: [{ open: { day: 0, hour: 0, minute: 0 } }],
    };
    const errors = await validateItinerary(
      { intent, candidates, itinerary: twoOptionPlan() },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.equal(
      errors.some((e) => e.code === "closed" && e.placeId === "ChIJ1"),
      false
    );
  });

  it("ignores a malformed no-close period", async () => {
    const candidates = fourCandidates();
    candidates[0] = {
      ...candidates[0]!,
      openingHours: [{ open: { day: 3, hour: 17, minute: 0 } }],
    };
    const errors = await validateItinerary(
      { intent, candidates, itinerary: twoOptionPlan() },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.ok(errors.some((e) => e.code === "closed" && e.placeId === "ChIJ1"));
  });

  it("does not let a malformed no-close override real hours", async () => {
    const candidates = fourCandidates();
    candidates[0] = {
      ...candidates[0]!,
      openingHours: [
        { open: { day: 3, hour: 17, minute: 0 } },
        { open: { day: 4, hour: 17, minute: 0 }, close: { day: 4, hour: 23, minute: 0 } },
      ],
    };
    const errors = await validateItinerary(
      { intent, candidates, itinerary: twoOptionPlan() },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.equal(
      errors.some((e) => e.code === "closed" && e.placeId === "ChIJ1"),
      false
    );
  });

  it("converts 23:30Z to America/New_York before hours check", async () => {
    const itinerary = twoOptionPlan();
    itinerary.options[0]!.stops[0]!.start = "2026-10-15T23:30:00Z";
    itinerary.options[0]!.stops[0]!.end = "2026-10-16T00:15:00Z";
    itinerary.options[0]!.stops[1]!.start = "2026-10-16T00:30:00Z";
    itinerary.options[0]!.stops[1]!.end = "2026-10-16T02:00:00Z";
    const candidates = fourCandidates();
    const errors = await validateItinerary(
      { intent, candidates, itinerary },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.equal(
      errors.some((e) => e.code === "closed" && e.optionIndex === 0),
      false,
      `23:30Z is 19:30 EDT; got ${JSON.stringify(errors)}`
    );
  });

  it("handles a slot that crosses midnight", async () => {
    const itinerary = twoOptionPlan();
    itinerary.options[0]!.stops[0]!.start = "2026-10-15T23:00:00-04:00";
    itinerary.options[0]!.stops[0]!.end = "2026-10-16T00:30:00-04:00";
    itinerary.options[0]!.stops[1]!.start = "2026-10-16T00:45:00-04:00";
    itinerary.options[0]!.stops[1]!.end = "2026-10-16T01:30:00-04:00";
    const lateHours = [
      { open: { day: 4, hour: 22, minute: 0 }, close: { day: 5, hour: 2, minute: 0 } },
    ];
    const candidates = fourCandidates().map((c) =>
      c.placeId === "ChIJ1" || c.placeId === "ChIJ2" ? { ...c, openingHours: lateHours } : c
    );
    const errors = await validateItinerary(
      { intent, candidates, itinerary },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.equal(
      errors.some((e) => e.code === "closed" && e.optionIndex === 0),
      false
    );
  });

  it("counts invented stop cost in the budget", async () => {
    const errors = await validateItinerary(
      {
        intent: { ...intent, budgetUsd: 100 },
        candidates: fourCandidates().filter((c) => c.placeId !== "ChIJ1"),
        itinerary: twoOptionPlan({ costs: [500, 20, 20, 20] }),
      },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.ok(errors.some((e) => e.code === "invented_venue"));
    assert.ok(
      errors.some((e) => e.code === "over_budget" && e.message.includes("$520"))
    );
  });

  it("flags claimed travel minutes over the cap via max(claimed, computed)", async () => {
    const errors = await validateItinerary(
      { intent, candidates: fourCandidates(), itinerary: twoOptionPlan({ travelMinutes: 30 }) },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.ok(
      errors.some(
        (e) => e.code === "travel_too_long" && e.message.includes("30 min")
      )
    );
  });

  it("flags |claimed − computed| beyond the tolerance", async () => {
    const errors = await validateItinerary(
      { intent, candidates: fourCandidates(), itinerary: twoOptionPlan({ travelMinutes: 10 }) },
      {
        travelCapMinutes: 25,
        travelCalculator: calc(20),
        travelToleranceMinutes: 5,
      }
    );
    assert.ok(
      errors.some(
        (e) =>
          e.code === "travel_mismatch" &&
          e.message.includes("claimed 10") &&
          e.message.includes("computed 20")
      )
    );
  });

  it("fails closed when the calculator returns null", async () => {
    const errors = await validateItinerary(
      { intent, candidates: fourCandidates(), itinerary: twoOptionPlan() },
      { travelCapMinutes: 25, travelCalculator: calc(null) }
    );
    assert.ok(errors.some((e) => e.code === "travel_unverified"));
  });

  it("fails closed when the calculator throws", async () => {
    const errors = await validateItinerary(
      { intent, candidates: fourCandidates(), itinerary: twoOptionPlan() },
      {
        travelCapMinutes: 25,
        travelCalculator: {
          calculateMinutes() {
            throw new Error("boom");
          },
        },
      }
    );
    assert.ok(errors.some((e) => e.code === "travel_unverified"));
  });

  it("fails closed when a calculator is omitted", async () => {
    const errors = await validateItinerary({
      intent,
      candidates: fourCandidates(),
      itinerary: twoOptionPlan(),
    });
    assert.ok(errors.some((e) => e.code === "travel_unverified"));
  });

  it("fails closed next to an invented stop", async () => {
    const errors = await validateItinerary(
      {
        intent,
        candidates: fourCandidates().filter((c) => c.placeId !== "ChIJ2"),
        itinerary: twoOptionPlan(),
      },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.ok(
      errors.some(
        (e) =>
          e.code === "travel_unverified" && e.message.includes("missing coordinates")
      )
    );
  });

  it("fails closed as travel_unverified for rideshare, drive, taxi, and lowercase aliases", async () => {
    for (const mode of ["rideshare", "drive", "taxi", "walk", "transit", "bicycle"] as const) {
      const itinerary = twoOptionPlan();
      setHopMode(itinerary, mode);
      const errors = await validateItinerary(
        { intent, candidates: fourCandidates(), itinerary },
        { travelCapMinutes: 25, travelCalculator: calc(10) }
      );
      assert.ok(
        errors.some(
          (e) =>
            e.code === "travel_unverified" &&
            e.message.toLowerCase().includes(mode)
        ),
        `expected travel_unverified for ${mode}: ${JSON.stringify(errors)}`
      );
    }
  });

  it("accepts identity travel modes WALK, TRANSIT, and BICYCLE", async () => {
    for (const mode of ["WALK", "TRANSIT", "BICYCLE"] as const) {
      const itinerary = twoOptionPlan();
      setHopMode(itinerary, mode);
      const errors = await validateItinerary(
        { intent, candidates: fourCandidates(), itinerary },
        { travelCapMinutes: 25, travelCalculator: calc(10) }
      );
      assert.deepEqual(errors, [], `expected ${mode} to pass: ${JSON.stringify(errors)}`);
    }
  });

  it("flags a name mismatch as name_mismatch", async () => {
    const itinerary = twoOptionPlan();
    itinerary.options[0]!.stops[0]!.name = "Wrong Name";
    const errors = await validateItinerary(
      { intent, candidates: fourCandidates(), itinerary },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.ok(errors.some((e) => e.code === "name_mismatch" && e.message.includes("Wrong Name")));
  });

  it("matches names case-insensitively and normalizes curly quotes", async () => {
    const itinerary = twoOptionPlan();
    itinerary.options[0]!.stops[0]!.name = "venue one";
    const candidates = fourCandidates();
    candidates[1] = { ...candidates[1]!, name: "Venue Two\u2019s" };
    itinerary.options[0]!.stops[1]!.name = "Venue Two's";
    const errors = await validateItinerary(
      { intent, candidates, itinerary },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.equal(
      errors.some((e) => e.code === "name_mismatch"),
      false,
      JSON.stringify(errors)
    );
  });

  it("flags implausible claimed cost for a price level", async () => {
    const candidates = fourCandidates();
    candidates[0] = { ...candidates[0]!, priceLevel: "PRICE_LEVEL_INEXPENSIVE" };
    const errors = await validateItinerary(
      {
        intent,
        candidates,
        itinerary: twoOptionPlan({ costs: [200, 40, 40, 40] }),
      },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.ok(
      errors.some(
        (e) =>
          e.code === "implausible_cost" &&
          e.message.includes("PRICE_LEVEL_INEXPENSIVE") &&
          e.message.includes("/person") &&
          e.stopIndex === 0
      )
    );
  });

  it("compares PRICE_LEVEL ranges to estimatedCostUsd divided by party size", async () => {
    const candidates = fourCandidates();
    candidates[0] = { ...candidates[0]!, priceLevel: "PRICE_LEVEL_INEXPENSIVE" };
    const partyTotalInsideRange = await validateItinerary(
      {
        intent,
        candidates,
        itinerary: twoOptionPlan({ costs: [60, 40, 40, 40] }),
      },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.equal(
      partyTotalInsideRange.some((e) => e.code === "implausible_cost"),
      false,
      JSON.stringify(partyTotalInsideRange)
    );

    const partyTotalOutsideRange = await validateItinerary(
      {
        intent,
        candidates,
        itinerary: twoOptionPlan({ costs: [100, 40, 40, 40] }),
      },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.ok(
      partyTotalOutsideRange.some(
        (e) =>
          e.code === "implausible_cost" &&
          e.message.includes("$50/person") &&
          e.stopIndex === 0
      ),
      JSON.stringify(partyTotalOutsideRange)
    );
  });

  it("skips the price-level check when PRICE_LEVEL_UNSPECIFIED", async () => {
    const candidates = fourCandidates();
    candidates[0] = { ...candidates[0]!, priceLevel: "PRICE_LEVEL_UNSPECIFIED" };
    const errors = await validateItinerary(
      {
        intent,
        candidates,
        itinerary: twoOptionPlan({ costs: [200, 40, 40, 40] }),
      },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.equal(
      errors.some((e) => e.message.includes("PRICE_LEVEL_UNSPECIFIED")),
      false
    );
  });

  it("returns a schema-valid error for a 1-option itinerary instead of throwing", async () => {
    const result = await validateItinerary({
      intent,
      candidates: fourCandidates(),
      itinerary: { options: twoOptionPlan().options.slice(0, 1) },
    });
    assert.ok(Array.isArray(result));
    assert.ok(result[0]);
    assert.doesNotThrow(() => validationErrorSchema.parse(result[0]));
    assert.equal(result[0]!.code, "invalid_format");
    assert.doesNotMatch(result[0]!.message, /\[\s*\{/);
    assert.match(result[0]!.message, /options/i);
  });

  it("returns a schema-valid error for a 4-option itinerary instead of throwing", async () => {
    const extra = structuredClone(twoOptionPlan());
    extra.options.push({
      theme: "Fourth",
      stops: extra.options[0]!.stops.map((s, i) => ({
        ...s,
        placeId: `ChIJ9${i}`,
        name: `Extra ${i}`,
      })),
    });
    extra.options.push({
      theme: "Fifth attempt",
      stops: extra.options[1]!.stops.map((s, i) => ({
        ...s,
        placeId: `ChIJ8${i}`,
        name: `More ${i}`,
      })),
    });
    const result = await validateItinerary({
      intent,
      candidates: fourCandidates(),
      itinerary: extra,
    });
    assert.equal(result[0]!.code, "invalid_format");
    assert.doesNotThrow(() => validationErrorSchema.parse(result[0]));
  });

  it("truncates messages to the schema max", async () => {
    const errors = await validateItinerary({
      intent,
      candidates: [],
      itinerary: { options: [] },
    });
    for (const error of errors) {
      assert.ok(error.message.length <= 300);
      validationErrorSchema.parse(error);
    }
  });

  it("runs every emitted error through validationErrorSchema", async () => {
    const candidates = [
      candidate("ChIJ1", "Venue One", { businessStatus: "CLOSED_TEMPORARILY" }),
      candidate("ChIJ3", "Venue Three", { priceLevel: "PRICE_LEVEL_INEXPENSIVE" }),
      candidate("ChIJ4", "Venue Four"),
    ];
    const itinerary = twoOptionPlan({ costs: [200, 200, 200, 200], travelMinutes: 40 });
    itinerary.options[0]!.stops[0]!.name = "Mismatch";
    const errors = await validateItinerary(
      { intent: { ...intent, budgetUsd: 50 }, candidates, itinerary },
      { travelCapMinutes: 25, travelCalculator: calc(null) }
    );
    assert.ok(errors.length >= 4);
    for (const error of errors) {
      assert.doesNotThrow(() => validationErrorSchema.parse(error));
    }
  });

  it("rejects out-of-order stops using the shared itinerary schema", async () => {
    const itinerary = twoOptionPlan();
    itinerary.options[0]!.stops[1]!.start = "2026-10-15T19:30:00-04:00";
    itinerary.options[0]!.stops[1]!.end = "2026-10-15T20:00:00-04:00";
    const errors = await validateItinerary(
      { intent, candidates: fourCandidates(), itinerary },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.ok(
      errors.some(
        (e) =>
          e.code === "invalid_format" &&
          e.message.toLowerCase().includes("chronological")
      ),
      JSON.stringify(errors)
    );
  });

  it("rejects out-of-order stops when the hop uses a contract travel mode", async () => {
    const itinerary = twoOptionPlan();
    setHopMode(itinerary, "WALK");
    itinerary.options[0]!.stops[1]!.start = "2026-10-15T19:30:00-04:00";
    itinerary.options[0]!.stops[1]!.end = "2026-10-15T20:00:00-04:00";
    const errors = await validateItinerary(
      { intent, candidates: fourCandidates(), itinerary },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.ok(
      errors.some(
        (e) =>
          e.code === "invalid_format" &&
          e.message.toLowerCase().includes("chronological")
      ),
      JSON.stringify(errors)
    );
  });

  it("rejects a shared venue using the shared itinerary schema", async () => {
    const itinerary = twoOptionPlan();
    itinerary.options[1]!.stops[0]!.placeId = "ChIJ1";
    const errors = await validateItinerary(
      { intent, candidates: fourCandidates(), itinerary },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.ok(
      errors.some(
        (e) =>
          e.code === "invalid_format" &&
          e.message.toLowerCase().includes("shared")
      ),
      JSON.stringify(errors)
    );
  });

  it("rejects a shared venue when the hop uses a contract travel mode", async () => {
    const itinerary = twoOptionPlan();
    setHopMode(itinerary, "BICYCLE");
    itinerary.options[1]!.stops[0]!.placeId = "ChIJ1";
    itinerary.options[1]!.stops[0]!.name = "Venue One";
    const errors = await validateItinerary(
      { intent, candidates: fourCandidates(), itinerary },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.ok(
      errors.some(
        (e) =>
          e.code === "invalid_format" &&
          e.message.toLowerCase().includes("shared")
      ),
      JSON.stringify(errors)
    );
  });

  it("returns invalid_format when singleStop is not a boolean", async () => {
    const errors = await validateItinerary(
      {
        intent: { ...intent, singleStop: "yes" },
        candidates: fourCandidates(),
        itinerary: twoOptionPlan(),
      },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.ok(
      errors.some(
        (e) =>
          e.code === "invalid_format" && e.message.toLowerCase().includes("singlestop")
      ),
      JSON.stringify(errors)
    );
  });

  it("fails closed as travel_unverified when the travel budget is exhausted", async () => {
    const errors = await validateItinerary(
      { intent, candidates: fourCandidates(), itinerary: twoOptionPlan() },
      {
        travelCapMinutes: 25,
        travelBudgetMs: 15,
        travelCalculator: {
          calculateMinutes() {
            return new Promise(() => {
              /* hang past the budget */
            });
          },
        },
      }
    );
    assert.ok(errors.some((e) => e.code === "travel_unverified"));
  });

  it("passes a valid single-stop itinerary when both flags are true", async () => {
    const errors = await validateItinerary(
      {
        intent: singleStopIntent,
        candidates: fourCandidates(),
        itinerary: oneStopPlan(true),
      },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.deepEqual(errors, [], JSON.stringify(errors));
  });

  it("fails when intent.singleStop is true and the itinerary flag is false", async () => {
    const errors = await validateItinerary(
      {
        intent: singleStopIntent,
        candidates: fourCandidates(),
        itinerary: oneStopPlan(false),
      },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.ok(
      errors.some(
        (e) =>
          e.code === "invalid_format" &&
          e.message.includes("itinerary.singleStop") &&
          e.message.includes("intent.singleStop")
      ),
      JSON.stringify(errors)
    );
  });

  it("fails when intent.singleStop is false and the itinerary flag is true", async () => {
    const errors = await validateItinerary(
      {
        intent: { ...intent, singleStop: false },
        candidates: fourCandidates(),
        itinerary: oneStopPlan(true),
      },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.ok(
      errors.some(
        (e) =>
          e.code === "invalid_format" &&
          e.message.includes("itinerary.singleStop") &&
          e.message.includes("intent.singleStop")
      ),
      JSON.stringify(errors)
    );
  });

  it("fails a 2-stop itinerary when singleStop is true on both sides", async () => {
    const errors = await validateItinerary(
      {
        intent: singleStopIntent,
        candidates: fourCandidates(),
        itinerary: { ...twoOptionPlan(), singleStop: true },
      },
      { travelCapMinutes: 25, travelCalculator: calc(10) }
    );
    assert.ok(
      errors.some(
        (e) =>
          e.code === "invalid_format" &&
          /exactly 1 stop|singleStop/i.test(e.message)
      ),
      JSON.stringify(errors)
    );
  });
});

function oneStopPlan(singleStop: boolean) {
  return {
    singleStop,
    options: [
      {
        theme: "Solo West",
        stops: [
          {
            placeId: "ChIJ1",
            name: "Venue One",
            start: "2026-10-15T19:00:00-04:00",
            end: "2026-10-15T20:00:00-04:00",
            estimatedCostUsd: 40,
            why: "Drinks",
            travelToNext: null,
          },
        ],
      },
      {
        theme: "Solo East",
        stops: [
          {
            placeId: "ChIJ3",
            name: "Venue Three",
            start: "2026-10-15T19:00:00-04:00",
            end: "2026-10-15T20:00:00-04:00",
            estimatedCostUsd: 40,
            why: "Drinks",
            travelToNext: null,
          },
        ],
      },
    ],
  };
}
