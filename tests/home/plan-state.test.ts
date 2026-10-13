import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { IDLE, nextRequestId, planReducer, type PlanState } from "../../app/_home/plan-state";
import { INTENT, OPTION_A, OPTION_B } from "../pipeline/orchestrator-harness";

function streaming(): PlanState {
  return planReducer(IDLE, { type: "submitted", requestId: nextRequestId() });
}

describe("planReducer", () => {
  it("starts a fresh stream from any state", () => {
    const requestId = nextRequestId();
    assert.deepEqual(planReducer(IDLE, { type: "submitted", requestId }), {
      kind: "streaming",
      requestId,
      intent: null,
      options: [null, null, null],
    });
  });

  it("drops a stale request id and ignores updates while idle", () => {
    const first = nextRequestId();
    const second = nextRequestId();
    const current = planReducer(planReducer(IDLE, { type: "submitted", requestId: first }), {
      type: "submitted",
      requestId: second,
    });
    assert.equal(
      planReducer(current, { type: "received", requestId: first, update: { kind: "intent", intent: INTENT } }),
      current,
    );
    assert.equal(
      planReducer(IDLE, { type: "received", requestId: first, update: { kind: "done", itineraryIds: [] } }),
      IDLE,
    );
  });

  it("fills intent and option slots, and a duplicate update is the same state", () => {
    const state = streaming();
    if (state.kind !== "streaming") throw new Error("expected streaming");
    const withIntent = planReducer(state, {
      type: "received",
      requestId: state.requestId,
      update: { kind: "intent", intent: INTENT },
    });
    const again = planReducer(withIntent, {
      type: "received",
      requestId: state.requestId,
      update: { kind: "intent", intent: INTENT },
    });
    assert.equal(again, withIntent);
    const withOption = planReducer(withIntent, {
      type: "received",
      requestId: state.requestId,
      update: { kind: "option", index: 0, option: OPTION_A },
    });
    const duplicate = planReducer(withOption, {
      type: "received",
      requestId: state.requestId,
      update: { kind: "option", index: 0, option: OPTION_A },
    });
    assert.equal(duplicate, withOption);
    assert.equal(withOption.kind, "streaming");
    if (withOption.kind !== "streaming") return;
    assert.equal(withOption.options[0], OPTION_A);
    assert.equal(withOption.options[1], null);
  });

  it("requires intent before done, and keeps partial results on failure", () => {
    const open = streaming();
    if (open.kind !== "streaming") throw new Error("expected streaming");
    const missing = planReducer(open, {
      type: "received",
      requestId: open.requestId,
      update: { kind: "done", itineraryIds: [] },
    });
    assert.deepEqual(missing, {
      kind: "failed",
      requestId: open.requestId,
      intent: null,
      options: [null, null, null],
      reason: "service_unavailable",
    });

    const withIntent = planReducer(open, {
      type: "received",
      requestId: open.requestId,
      update: { kind: "intent", intent: INTENT },
    });
    const withOption = planReducer(withIntent, {
      type: "received",
      requestId: open.requestId,
      update: { kind: "option", index: 1, option: OPTION_B },
    });
    const ids = ["11111111-1111-4111-8111-111111111111"] as const;
    const done = planReducer(withOption, {
      type: "received",
      requestId: open.requestId,
      update: { kind: "done", itineraryIds: ids },
    });
    assert.equal(done.kind, "done");
    if (done.kind !== "done") return;
    assert.equal(done.intent, INTENT);
    assert.equal(done.options[1], OPTION_B);
    assert.deepEqual(done.itineraryIds, [...ids]);

    const failed = planReducer(withOption, {
      type: "received",
      requestId: open.requestId,
      update: { kind: "failed", reason: "connection_lost" },
    });
    assert.equal(failed.kind, "failed");
    if (failed.kind !== "failed") return;
    assert.equal(failed.intent, INTENT);
    assert.equal(failed.options[1], OPTION_B);
    assert.equal(failed.reason, "connection_lost");
  });
});
