import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getPlannerMode } from "../../src/models/config";

describe("getPlannerMode", () => {
  it("defaults to model when unset or empty", () => {
    assert.equal(getPlannerMode({}), "model");
    assert.equal(getPlannerMode({ NIGHTCAP_PLANNER: "" }), "model");
    assert.equal(getPlannerMode({ NIGHTCAP_PLANNER: "  " }), "model");
  });

  it("accepts assembler and plan-card", () => {
    assert.equal(getPlannerMode({ NIGHTCAP_PLANNER: "assembler" }), "assembler");
    assert.equal(getPlannerMode({ NIGHTCAP_PLANNER: "plan-card" }), "plan-card");
    assert.equal(getPlannerMode({ NIGHTCAP_PLANNER: "model" }), "model");
  });

  it("throws on unknown values", () => {
    assert.throws(() => getPlannerMode({ NIGHTCAP_PLANNER: "lanes" }), /NIGHTCAP_PLANNER/);
  });
});
