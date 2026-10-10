import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { z } from "zod";

import { itinerarySchema as agentItinerarySchema, toolInputSchema } from "../../src/agent";
import {
  MAX_TRAVEL_LEGS_PER_REQUEST_DEFAULT as CONTRACT_MAX_LEGS,
  STOPS_MAX as CONTRACT_STOPS_MAX,
  STOPS_MIN as CONTRACT_STOPS_MIN,
  STOPS_MIN_SINGLE as CONTRACT_STOPS_MIN_SINGLE,
} from "../../src/contracts/itinerary";
import {
  MAX_TRAVEL_LEGS_PER_REQUEST_DEFAULT,
  STOPS_MAX,
  STOPS_MIN,
  STOPS_MIN_SINGLE,
} from "../../src/validation/bounds";
import { itinerarySchema as evalItinerarySchema } from "../../evaluation";
import { intentSchema, itinerarySchema as pipelineItinerarySchema } from "../../src/pipeline";
import {
  candidateSchema,
  itineraryOptionSchema,
  itineraryOptionSchemaFor,
  itinerarySchema,
  parseItinerary,
  validationErrorSchema,
} from "../../src/validation";
import type { Stop } from "../../src/validation";

const START = "2026-10-10T19:00:00-04:00";
const MID = "2026-10-10T20:30:00-04:00";
const LATER = "2026-10-10T21:00:00-04:00";
const END = "2026-10-10T22:30:00-04:00";

function stop(placeId: string, start: string, end: string, travel: Stop["travelToNext"]): Stop {
  return {
    placeId,
    name: placeId,
    start,
    end,
    estimatedCostUsd: 40,
    why: "Quiet room and a short walk.",
    travelToNext: travel,
  };
}

function option(theme: string, stops: Stop[]) {
  return { theme, stops };
}

function validItinerary(): z.input<typeof itinerarySchema> {
  return {
    options: [
      option("Low-key West Village", [
        stop("place-a", START, MID, { mode: "WALK", minutes: 12 }),
        stop("place-b", LATER, END, null),
      ]),
      option("East Village night", [
        stop("place-c", START, MID, { mode: "TRANSIT", minutes: 18 }),
        stop("place-d", LATER, END, { mode: "WALK", minutes: 8 }),
        stop("place-e", "2026-10-10T22:45:00-04:00", "2026-10-11T00:00:00-04:00", null),
      ]),
    ],
  };
}

describe("itinerary contracts", () => {
  it("exports named stop-count constants from validation/bounds and re-exports them from contracts", () => {
    assert.equal(STOPS_MIN, 2);
    assert.equal(STOPS_MIN_SINGLE, 1);
    assert.equal(STOPS_MAX, 4);
    assert.equal(CONTRACT_STOPS_MIN, STOPS_MIN);
    assert.equal(CONTRACT_STOPS_MIN_SINGLE, STOPS_MIN_SINGLE);
    assert.equal(CONTRACT_STOPS_MAX, STOPS_MAX);
    assert.equal(MAX_TRAVEL_LEGS_PER_REQUEST_DEFAULT, 4);
    assert.equal(CONTRACT_MAX_LEGS, MAX_TRAVEL_LEGS_PER_REQUEST_DEFAULT);
  });
});

describe("itinerary schema", () => {
  it("accepts 2–3 options of 2–4 timed stops with no shared venue", () => {
    const parsed = parseItinerary(validItinerary());
    assert.equal(parsed.singleStop, false);
    assert.deepEqual(parsed.options, validItinerary().options);
  });

  it("rejects fewer than 2 options", () => {
    const itinerary = validItinerary();
    itinerary.options = [itinerary.options[0]];
    assert.equal(itinerarySchema.safeParse(itinerary).success, false);
  });

  it("rejects more than 3 options", () => {
    const itinerary = validItinerary();
    itinerary.options.push(
      option("Brooklyn", [
        stop("place-f", START, MID, { mode: "WALK", minutes: 10 }),
        stop("place-g", LATER, END, null),
      ]),
    );
    itinerary.options.push(
      option("Queens", [
        stop("place-h", START, MID, { mode: "WALK", minutes: 10 }),
        stop("place-i", LATER, END, null),
      ]),
    );
    assert.equal(itinerarySchema.safeParse(itinerary).success, false);
  });

  it("rejects an option with fewer than 2 stops", () => {
    const itinerary = validItinerary();
    itinerary.options[0].stops = [itinerary.options[0].stops[1]];
    assert.equal(itinerarySchema.safeParse(itinerary).success, false);
  });

  it("allows a 1-stop option only when singleStop is true", () => {
    const oneStop = option("Just dinner", [stop("place-solo", START, END, null)]);
    const twoStop = option("Also just dinner", [stop("place-solo-2", START, END, null)]);
    assert.equal(
      itinerarySchema.safeParse({
        options: [oneStop, twoStop],
      }).success,
      false,
    );
    const parsed = itinerarySchema.parse({
      singleStop: true,
      options: [oneStop, twoStop],
    });
    assert.equal(parsed.singleStop, true);
    assert.equal(parsed.options[0].stops.length, 1);
  });

  it("itineraryOptionSchemaFor(true) accepts a 1-stop option; the default schema still rejects it", () => {
    const one = option("Just dinner", [stop("place-solo", START, END, null)]);
    assert.equal(itineraryOptionSchema.safeParse(one).success, false);
    assert.equal(itineraryOptionSchemaFor(false).safeParse(one).success, false);
    assert.equal(itineraryOptionSchemaFor(true).safeParse(one).success, true);
  });

  it("requires exactly one stop per option when singleStop is true", () => {
    const oneStop = option("Just dinner", [stop("place-solo", START, END, null)]);
    const alsoOne = option("Also dinner", [stop("place-solo-2", START, END, null)]);
    const twoStop = option("Two stops", [
      stop("place-a", START, MID, { mode: "WALK", minutes: 12 }),
      stop("place-b", LATER, END, null),
    ]);
    assert.equal(
      itinerarySchema.safeParse({ singleStop: true, options: [oneStop, twoStop] }).success,
      false,
    );
    assert.equal(
      itineraryOptionSchemaFor(true).safeParse(twoStop).success,
      false,
    );
    assert.equal(
      itinerarySchema.safeParse({ singleStop: true, options: [oneStop, alsoOne] }).success,
      true,
    );
  });

  it("rejects an option with more than 4 stops", () => {
    const itinerary = validItinerary();
    itinerary.options[0] = option("Too many", [
      stop("p1", "2026-10-10T17:00:00-04:00", "2026-10-10T18:00:00-04:00", { mode: "WALK", minutes: 5 }),
      stop("p2", "2026-10-10T18:10:00-04:00", "2026-10-10T19:00:00-04:00", { mode: "WALK", minutes: 5 }),
      stop("p3", "2026-10-10T19:10:00-04:00", "2026-10-10T20:00:00-04:00", { mode: "WALK", minutes: 5 }),
      stop("p4", "2026-10-10T20:10:00-04:00", "2026-10-10T21:00:00-04:00", { mode: "WALK", minutes: 5 }),
      stop("p5", "2026-10-10T21:10:00-04:00", "2026-10-10T22:00:00-04:00", null),
    ]);
    assert.equal(itinerarySchema.safeParse(itinerary).success, false);
  });

  it("rejects a venue shared between options", () => {
    const itinerary = validItinerary();
    itinerary.options[1].stops[0].placeId = "place-a";
    const parsed = itinerarySchema.safeParse(itinerary);
    assert.equal(parsed.success, false);
    if (!parsed.success) {
      assert.match(parsed.error.issues.map((issue) => issue.message).join(" "), /shared/);
    }
  });

  it("rejects non-null travelToNext on the last stop", () => {
    const itinerary = validItinerary();
    itinerary.options[0].stops[1].travelToNext = { mode: "WALK", minutes: 10 };
    const parsed = itinerarySchema.safeParse(itinerary);
    assert.equal(parsed.success, false);
    if (!parsed.success) {
      assert.match(parsed.error.issues.map((issue) => issue.message).join(" "), /last stop/i);
    }
  });

  it("rejects null travelToNext on a non-last stop", () => {
    const itinerary = validItinerary();
    itinerary.options[1].stops[1].travelToNext = null;
    const parsed = itinerarySchema.safeParse(itinerary);
    assert.equal(parsed.success, false);
    if (!parsed.success) {
      assert.match(parsed.error.issues.map((issue) => issue.message).join(" "), /except the last/i);
    }
  });

  it("rejects stops not in chronological order", () => {
    const itinerary = validItinerary();
    itinerary.options[0].stops[1].start = "2026-10-10T18:00:00-04:00";
    const parsed = itinerarySchema.safeParse(itinerary);
    assert.equal(parsed.success, false);
    if (!parsed.success) {
      assert.match(parsed.error.issues.map((issue) => issue.message).join(" "), /chronological/i);
    }
  });
});

describe("boundary schemas", () => {
  it("parses intent", () => {
    const parsed = intentSchema.parse({
      area: "Union Square",
      window: { start: START, end: END },
      budgetUsd: 120,
      dietary: ["vegetarian"],
      vibeTags: ["low-key"],
      stopTypes: ["drinks", "dinner"],
    });
    assert.equal(parsed.budgetUsd, 120);
    assert.equal(parsed.singleStop, false);
  });

  it("defaults singleStop to false and rejects a one-type request unless the flag is set", () => {
    const base = {
      area: "Union Square",
      window: { start: START, end: END },
      budgetUsd: 120,
      dietary: [] as string[],
      vibeTags: [] as string[],
    };
    assert.equal(
      intentSchema.safeParse({ ...base, stopTypes: ["dinner"] }).success,
      false,
    );
    const explicit = intentSchema.parse({
      ...base,
      stopTypes: ["dinner"],
      singleStop: true,
    });
    assert.equal(explicit.singleStop, true);
    assert.deepEqual(explicit.stopTypes, ["dinner"]);
    assert.equal(
      intentSchema.safeParse({
        ...base,
        stopTypes: ["dinner", "drinks"],
        singleStop: true,
      }).success,
      false,
    );
  });

  it("parses a Places candidate", () => {
    const parsed = candidateSchema.parse({
      placeId: "place-a",
      name: "Example Bar",
      businessStatus: "OPERATIONAL",
      priceLevel: "PRICE_LEVEL_MODERATE",
      rating: 4.4,
      reviewCount: 800,
      location: { lat: 40.735, lng: -73.99 },
      openingHours: [{ open: { day: 6, hour: 17, minute: 0 }, close: { day: 0, hour: 0, minute: 0 } }],
      types: ["bar"],
      stopType: "drinks",
    });
    assert.equal(parsed.businessStatus, "OPERATIONAL");
  });

  it("parses a validation error", () => {
    const parsed = validationErrorSchema.parse({
      code: "travel_too_long",
      message: "Walk from dinner to the bar is 40 minutes.",
      optionIndex: 0,
      stopIndex: 1,
      placeId: "place-b",
    });
    assert.equal(parsed.code, "travel_too_long");
  });

  it("parses the split validation error codes", () => {
    for (const code of [
      "invalid_format",
      "name_mismatch",
      "implausible_cost",
      "travel_unverified",
      "travel_mismatch",
    ] as const) {
      assert.equal(
        validationErrorSchema.parse({ code, message: `code ${code}` }).code,
        code
      );
    }
  });

  it("parses each tool input", () => {
    assert.equal(
      toolInputSchema.parse({
        tool: "search_venues",
        area: "East Village",
        category: "dinner",
        priceLevel: "PRICE_LEVEL_MODERATE",
        openAt: START,
      }).tool,
      "search_venues",
    );
    assert.equal(
      toolInputSchema.parse({ tool: "replace_stop", optionIndex: 0, stopIndex: 1, placeId: "place-z" }).tool,
      "replace_stop",
    );
    assert.equal(
      toolInputSchema.parse({
        tool: "reorder_stops",
        optionIndex: 0,
        order: [1, 0],
        times: [
          { start: START, end: MID },
          { start: LATER, end: END },
        ],
      }).tool,
      "reorder_stops",
    );
    assert.equal(
      toolInputSchema.parse({ tool: "validate_itinerary", itinerary: validItinerary() }).tool,
      "validate_itinerary",
    );
  });

  it("rejects reorder_stops with mismatched order and times length", () => {
    const parsed = toolInputSchema.safeParse({
      tool: "reorder_stops",
      optionIndex: 0,
      order: [1, 0],
      times: [{ start: START, end: MID }],
    });
    assert.equal(parsed.success, false);
    if (!parsed.success) {
      assert.match(parsed.error.issues.map((issue) => issue.message).join(" "), /same length/i);
    }
  });

  it("rejects reorder_stops with duplicate stop indices", () => {
    const parsed = toolInputSchema.safeParse({
      tool: "reorder_stops",
      optionIndex: 0,
      order: [1, 1],
      times: [
        { start: START, end: MID },
        { start: LATER, end: END },
      ],
    });
    assert.equal(parsed.success, false);
    if (!parsed.success) {
      assert.match(parsed.error.issues.map((issue) => issue.message).join(" "), /not repeat/i);
    }
  });

  it("accepts reorder_stops with a single stop so a 1-stop option can be retimed", () => {
    const parsed = toolInputSchema.safeParse({
      tool: "reorder_stops",
      optionIndex: 0,
      order: [0],
      times: [{ start: START, end: MID }],
    });
    assert.equal(parsed.success, true);
  });

  it("rejects reorder_stops with an empty order", () => {
    const parsed = toolInputSchema.safeParse({
      tool: "reorder_stops",
      optionIndex: 0,
      order: [],
      times: [],
    });
    assert.equal(parsed.success, false);
  });

  it("rejects reorder_stops with too many stops", () => {
    const parsed = toolInputSchema.safeParse({
      tool: "reorder_stops",
      optionIndex: 0,
      order: [0, 1, 2, 3, 4],
      times: [
        { start: START, end: MID },
        { start: LATER, end: END },
        { start: "2026-10-10T23:00:00-04:00", end: "2026-10-11T00:00:00-04:00" },
        { start: "2026-10-11T00:15:00-04:00", end: "2026-10-11T01:00:00-04:00" },
        { start: "2026-10-11T01:15:00-04:00", end: "2026-10-11T02:00:00-04:00" },
      ],
    });
    assert.equal(parsed.success, false);
  });


  it("uses the same itinerary schema from pipeline, agent, and eval", () => {
    assert.equal(pipelineItinerarySchema, itinerarySchema);
    assert.equal(agentItinerarySchema, itinerarySchema);
    assert.equal(evalItinerarySchema, itinerarySchema);
  });
});
