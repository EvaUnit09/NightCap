import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nextRequestId, type PlanState } from "../../app/_home/plan-state";
import { filledOptions, selectNight } from "../../app/_home/selection";
import { INTENT, OPTION_A, OPTION_B } from "../pipeline/orchestrator-harness";

const IDS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"] as const;

function donePlan(overrides?: Partial<Extract<PlanState, { kind: "done" }>>): Extract<PlanState, { kind: "done" }> {
  return {
    kind: "done",
    requestId: nextRequestId(),
    intent: INTENT,
    options: [OPTION_A, OPTION_B, null],
    itineraryIds: [...IDS],
    ...overrides,
  };
}

describe("filledOptions", () => {
  it("stops at the first empty slot", () => {
    assert.deepEqual(filledOptions([OPTION_A, null, OPTION_B]), [OPTION_A]);
    assert.deepEqual(filledOptions([OPTION_A, OPTION_B, null]), [OPTION_A, OPTION_B]);
  });
});

describe("selectNight", () => {
  it("clamps the index once so map stops and save id stay aligned", () => {
    const night = selectNight(donePlan(), 99);
    assert.equal(night.index, 1);
    assert.equal(night.itineraryId, IDS[1]);
    assert.deepEqual(
      night.mapStops.map((stop) => stop.placeId),
      OPTION_B.stops.map((stop) => stop.placeId),
    );
  });

  it("omits itineraryId when ids do not line up with filled options", () => {
    const night = selectNight(donePlan({ itineraryIds: [IDS[0]] }), 0);
    assert.equal(night.index, 0);
    assert.equal(night.itineraryId, undefined);
    assert.equal(night.mapStops.length, OPTION_A.stops.length);
  });

  it("returns empty stops and no id when there are no filled options", () => {
    const night = selectNight(donePlan({ options: [null, null, null], itineraryIds: [] }), 2);
    assert.equal(night.index, 0);
    assert.equal(night.itineraryId, undefined);
    assert.deepEqual(night.mapStops, []);
  });
});
