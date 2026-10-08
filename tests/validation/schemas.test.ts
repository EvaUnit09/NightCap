import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { itinerarySchema as agentItinerarySchema, toolInputSchema } from "../../src/agent";
import { itinerarySchema as evalItinerarySchema } from "../../evaluation";
import { intentSchema, itinerarySchema as pipelineItinerarySchema } from "../../src/pipeline";
import {
  candidateSchema,
  itinerarySchema,
  parseItinerary,
  validationErrorSchema,
} from "../../src/validation";
import type { Itinerary, Stop } from "../../src/validation";

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

function validItinerary(): Itinerary {
  return {
    options: [
      option("Low-key West Village", [
        stop("place-a", START, MID, { mode: "walk", minutes: 12 }),
        stop("place-b", LATER, END, null),
      ]),
      option("East Village night", [
        stop("place-c", START, MID, { mode: "transit", minutes: 18 }),
        stop("place-d", LATER, END, { mode: "walk", minutes: 8 }),
        stop("place-e", "2026-10-10T22:45:00-04:00", "2026-10-11T00:00:00-04:00", null),
      ]),
    ],
  };
}

describe("itinerary schema", () => {
  it("accepts 2–3 options of 2–4 timed stops with no shared venue", () => {
    assert.deepEqual(parseItinerary(validItinerary()), validItinerary());
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
        stop("place-f", START, MID, { mode: "walk", minutes: 10 }),
        stop("place-g", LATER, END, null),
      ]),
    );
    itinerary.options.push(
      option("Queens", [
        stop("place-h", START, MID, { mode: "walk", minutes: 10 }),
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

  it("rejects an option with more than 4 stops", () => {
    const itinerary = validItinerary();
    itinerary.options[0] = option("Too many", [
      stop("p1", "2026-10-10T17:00:00-04:00", "2026-10-10T18:00:00-04:00", { mode: "walk", minutes: 5 }),
      stop("p2", "2026-10-10T18:10:00-04:00", "2026-10-10T19:00:00-04:00", { mode: "walk", minutes: 5 }),
      stop("p3", "2026-10-10T19:10:00-04:00", "2026-10-10T20:00:00-04:00", { mode: "walk", minutes: 5 }),
      stop("p4", "2026-10-10T20:10:00-04:00", "2026-10-10T21:00:00-04:00", { mode: "walk", minutes: 5 }),
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
      toolInputSchema.parse({ tool: "replace_stop", stopIndex: 1, placeId: "place-z" }).tool,
      "replace_stop",
    );
    assert.equal(
      toolInputSchema.parse({
        tool: "reorder_stops",
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

  it("uses the same itinerary schema from pipeline, agent, and eval", () => {
    assert.equal(pipelineItinerarySchema, itinerarySchema);
    assert.equal(agentItinerarySchema, itinerarySchema);
    assert.equal(evalItinerarySchema, itinerarySchema);
  });
});
