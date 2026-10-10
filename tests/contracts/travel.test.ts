import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TRAVEL_MODES, travelModeSchema } from "../../src/contracts/travel";

describe("travelModeSchema", () => {
  it("accepts exactly TRANSIT, BICYCLE, and WALK", () => {
    assert.deepEqual([...TRAVEL_MODES], ["TRANSIT", "BICYCLE", "WALK"]);
    for (const mode of TRAVEL_MODES) {
      assert.equal(travelModeSchema.safeParse(mode).success, true);
    }
  });

  it("rejects dropped modes and does not map them", () => {
    for (const mode of ["rideshare", "DRIVE", "taxi", "walk", "transit", "bicycle"]) {
      assert.equal(
        travelModeSchema.safeParse(mode).success,
        false,
        `expected ${mode} to fail without mapping`,
      );
    }
  });
});
