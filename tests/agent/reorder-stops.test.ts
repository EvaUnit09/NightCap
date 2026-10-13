import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runReorderStops } from "../../src/agent";
import type { Itinerary } from "../../src/validation/itinerary";
import { baseContext, sampleItinerary } from "./fixtures";

const TIMES = [
  { start: "2026-10-10T19:30:00-04:00", end: "2026-10-10T20:45:00-04:00" },
  { start: "2026-10-10T21:00:00-04:00", end: "2026-10-10T22:30:00-04:00" },
];

describe("reorder_stops", () => {
  it("reorders stops and applies new times", async () => {
    const result = await runReorderStops(
      { tool: "reorder_stops", optionIndex: 0, order: [1, 0], times: TIMES },
      baseContext(),
    );
    assert.equal(result.is_error, false);
    if (result.is_error) return;
    const content = result.content as { itinerary: Itinerary };
    const stops = content.itinerary.options[0].stops;
    assert.equal(stops[0].placeId, "place-b");
    assert.equal(stops[1].placeId, "place-a");
    assert.equal(stops[0].start, TIMES[0].start);
    assert.equal(stops[1].travelToNext, null);
  });

  it("rejects an unknown optionIndex", async () => {
    const result = await runReorderStops(
      { tool: "reorder_stops", optionIndex: 9, order: [0, 1], times: TIMES },
      baseContext(),
    );
    assert.equal(result.is_error, true);
    if (!result.is_error) return;
    assert.equal(result.error.code, "unknown_option");
  });

  it("rejects an unknown stop index in order", async () => {
    const result = await runReorderStops(
      { tool: "reorder_stops", optionIndex: 0, order: [0, 5], times: TIMES },
      baseContext(),
    );
    assert.equal(result.is_error, true);
    if (!result.is_error) return;
    assert.equal(result.error.code, "unknown_stop");
  });

  it("rejects a non-permutation order", async () => {
    const result = await runReorderStops(
      { tool: "reorder_stops", optionIndex: 0, order: [0, 0], times: TIMES },
      baseContext({ itinerary: sampleItinerary() }),
    );
    assert.equal(result.is_error, true);
    if (!result.is_error) return;
    assert.ok(result.error.code === "invalid_order" || result.error.code === "unknown_stop");
  });
});
