import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { travelModeSchema as contractTravelModeSchema } from "../../src/contracts/travel";
import {
  parseItinerary,
  stopSchema,
  travelModeSchema,
} from "../../src/validation";
import { travelModeSchema as commonTravelModeSchema } from "../../src/validation/common";

const START = "2026-10-10T19:00:00-04:00";
const END = "2026-10-10T20:30:00-04:00";
const LATER = "2026-10-10T21:00:00-04:00";
const LAST = "2026-10-10T22:30:00-04:00";

function stop(placeId: string, mode: string | null) {
  return {
    placeId,
    name: placeId,
    start: mode ? START : LATER,
    end: mode ? END : LAST,
    estimatedCostUsd: 40,
    why: "Quiet room and a short walk.",
    travelToNext: mode ? { mode, minutes: 10 } : null,
  };
}

describe("travelModeSchema SSOT", () => {
  it("is the same enum from validation/common, the validation barrel, and contracts", () => {
    assert.equal(travelModeSchema, commonTravelModeSchema);
    assert.equal(contractTravelModeSchema, commonTravelModeSchema);
    assert.deepEqual(travelModeSchema.options, ["TRANSIT", "BICYCLE", "WALK"]);
  });

  it("rejects rideshare, taxi, DRIVE, and lowercase modes on stopSchema", () => {
    for (const mode of ["rideshare", "taxi", "DRIVE", "walk", "transit", "bicycle"]) {
      const parsed = stopSchema.safeParse(stop("place-a", mode));
      assert.equal(parsed.success, false, `stopSchema should reject ${mode}`);
    }
  });

  it("accepts TRANSIT, BICYCLE, and WALK on stopSchema", () => {
    for (const mode of ["TRANSIT", "BICYCLE", "WALK"]) {
      assert.equal(stopSchema.safeParse(stop("place-a", mode)).success, true);
    }
  });

  it("trims and uppercases at parseItinerary only, and never maps dropped modes", () => {
    const base = {
      options: [
        {
          theme: "One",
          stops: [stop("place-a", " walk "), stop("place-b", null)],
        },
        {
          theme: "Two",
          stops: [stop("place-c", "WALK"), stop("place-d", null)],
        },
      ],
    };
    const parsed = parseItinerary(base);
    assert.equal(parsed.options[0].stops[0].travelToNext?.mode, "WALK");

    for (const dropped of ["rideshare", "taxi", "DRIVE"]) {
      const bad = {
        options: [
          { theme: "One", stops: [stop("place-a", dropped), stop("place-b", null)] },
          { theme: "Two", stops: [stop("place-c", "WALK"), stop("place-d", null)] },
        ],
      };
      assert.throws(() => parseItinerary(bad), undefined, `expected ${dropped} to fail`);
    }
  });
});
