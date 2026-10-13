import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { initialScreen, reduceScreen } from "../../src/client/request-screen-state";
import { INTENT, OPTION_A } from "../pipeline/orchestrator-harness";

describe("request screen state", () => {
  it("starts idle and becomes a finished night after intent, one itinerary, and done", () => {
    const planning = reduceScreen(initialScreen(undefined), { type: "submit" });
    const withIntent = reduceScreen(planning, { type: "intent", intent: INTENT });
    const withOption = reduceScreen(withIntent, { type: "itinerary", option: OPTION_A });
    const ready = reduceScreen(withOption, { type: "done" });

    assert.deepEqual(ready, { phase: "ready", intent: INTENT, options: [OPTION_A] });
  });

  it("replaces a planning night with the daily cap message and no options", () => {
    const planning = reduceScreen(reduceScreen(initialScreen(undefined), { type: "submit" }), {
      type: "itinerary",
      option: OPTION_A,
    });
    const capped = reduceScreen(planning, { type: "daily_spend_cap", message: "Come back tomorrow." });

    assert.deepEqual(capped, { phase: "daily_spend_cap", message: "Come back tomorrow." });
  });

  it("shows an hourly limit message", () => {
    const limited = reduceScreen(initialScreen(undefined), {
      type: "hourly_plan_limit",
      message: "Too many plans from this network. Try again in an hour.",
    });

    assert.deepEqual(limited, {
      phase: "hourly_plan_limit",
      message: "Too many plans from this network. Try again in an hour.",
    });
  });

  it("drops timelines when the stream fails", () => {
    const planning = reduceScreen(reduceScreen(initialScreen(undefined), { type: "submit" }), {
      type: "itinerary",
      option: OPTION_A,
    });

    assert.deepEqual(reduceScreen(planning, { type: "failed", code: "no_valid_options" }), {
      phase: "failed",
      code: "no_valid_options",
    });
  });

  it("loads a reloaded plan only from the reloading phase", () => {
    const stops = [
      {
        placeId: "ChIJbar0",
        name: "Little Branch",
        why: "Quiet room",
        start: "2026-10-16T19:00:00-04:00",
      },
    ];
    const reloading = initialScreen("11111111-1111-4111-8111-111111111111");
    assert.equal(reloading.phase, "reloading");
    assert.deepEqual(reduceScreen(reloading, { type: "reload_ready", id: "11111111-1111-4111-8111-111111111111", stops }), {
      phase: "reloaded",
      id: "11111111-1111-4111-8111-111111111111",
      stops,
    });

    const planning = reduceScreen(initialScreen(undefined), { type: "submit" });
    assert.equal(reduceScreen(planning, { type: "reload_ready", id: "11111111-1111-4111-8111-111111111111", stops }), planning);
  });
});
