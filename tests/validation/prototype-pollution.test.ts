import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseItinerary, parseToolInput } from "../../src/validation";

function stop(placeId: string, mode: string | null) {
  return {
    placeId,
    name: placeId,
    start: mode ? "2026-10-10T19:00:00-04:00" : "2026-10-10T21:00:00-04:00",
    end: mode ? "2026-10-10T20:30:00-04:00" : "2026-10-10T22:30:00-04:00",
    estimatedCostUsd: 40,
    why: "Quiet room and a short walk.",
    travelToNext: mode ? { mode, minutes: 10 } : null,
  };
}

function itineraryJson(pollutionKey: string): unknown {
  const body = {
    options: [
      { theme: "One", stops: [stop("place-a", "WALK"), stop("place-b", null)] },
      { theme: "Two", stops: [stop("place-c", "WALK"), stop("place-d", null)] },
    ],
  };
  return JSON.parse(
    `{"${pollutionKey}":{"singleStop":true},${JSON.stringify(body).slice(1)}`,
  );
}

describe("prototype pollution at the model-output boundary", () => {
  it("parseItinerary ignores __proto__, constructor, and prototype keys", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const parsed = parseItinerary(itineraryJson(key));
      assert.equal(parsed.singleStop, false, `${key} must not set singleStop`);
      assert.equal(Object.hasOwn(Object.prototype, "singleStop"), false);
    }
  });

  it("parseToolInput ignores __proto__, constructor, and prototype keys", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const parsed = parseToolInput({
        tool: "validate_itinerary",
        itinerary: itineraryJson(key),
      });
      if (parsed.tool !== "validate_itinerary") {
        assert.fail("expected validate_itinerary");
      }
      assert.equal(parsed.itinerary.singleStop, false, `${key} must not set singleStop`);
      assert.equal(Object.hasOwn(Object.prototype, "singleStop"), false);
    }
  });
});
