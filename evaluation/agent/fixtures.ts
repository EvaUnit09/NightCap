import type { Candidate } from "../../src/validation/candidate";
import type { Intent } from "../../src/validation/intent";
import type { Itinerary } from "../../src/validation/itinerary";
import type { Stop } from "../../src/validation/stop";

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

export function agentEvalItinerary(): Itinerary {
  return {
    singleStop: false,
    options: [
      {
        theme: "Low-key West Village",
        stops: [
          stop("place-a", START, MID, { mode: "WALK", minutes: 12 }),
          stop("place-b", LATER, END, null),
        ],
      },
      {
        theme: "East Village night",
        stops: [
          stop("place-c", START, MID, { mode: "TRANSIT", minutes: 18 }),
          stop("place-d", LATER, END, null),
        ],
      },
    ],
  };
}

export function agentEvalIntent(): Intent {
  return {
    area: "West Village",
    window: { start: START, end: END },
    budgetUsd: 200,
    dietary: [],
    vibeTags: ["quiet"],
    stopTypes: ["dinner", "drinks"],
    singleStop: false,
  };
}

export function agentEvalCandidate(placeId: string, stopType: Candidate["stopType"] = "dinner"): Candidate {
  return {
    placeId,
    name: placeId,
    businessStatus: "OPERATIONAL",
    priceLevel: "PRICE_LEVEL_MODERATE",
    rating: 4.4,
    reviewCount: 80,
    location: { lat: 40.735, lng: -74.002 },
    openingHours: [
      { open: { day: 4, hour: 17, minute: 0 }, close: { day: 4, hour: 23, minute: 0 } },
      { open: { day: 5, hour: 17, minute: 0 }, close: { day: 5, hour: 23, minute: 0 } },
    ],
    types: ["restaurant"],
    stopType,
  };
}

export const REORDER_TIMES = [
  { start: "2026-10-10T19:30:00-04:00", end: "2026-10-10T20:45:00-04:00" },
  { start: "2026-10-10T21:00:00-04:00", end: "2026-10-10T22:30:00-04:00" },
] as const;
