import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { HaversineEstimator } from "../../src/validation/travel";

describe("HaversineEstimator", () => {
  const calculator = new HaversineEstimator();

  it("should calculate walk time for short distance", () => {
    const from = { lat: 40.7589, lng: -73.9851 };
    const to = { lat: 40.7600, lng: -73.9860 };

    const minutes = calculator.calculateMinutes(from, to, "walk");

    assert.ok(minutes > 0, "Should return positive minutes");
    assert.ok(minutes < 10, "Short walk should be under 10 minutes");
  });

  it("should calculate transit time for medium distance", () => {
    const from = { lat: 40.7589, lng: -73.9851 };
    const to = { lat: 40.7800, lng: -73.9600 };

    const minutes = calculator.calculateMinutes(from, to, "transit");

    assert.ok(minutes > 0, "Should return positive minutes");
    assert.ok(minutes > 5, "Medium transit should be over 5 minutes");
  });

  it("should calculate rideshare time", () => {
    const from = { lat: 40.7589, lng: -73.9851 };
    const to = { lat: 40.7800, lng: -73.9600 };

    const minutes = calculator.calculateMinutes(from, to, "rideshare");

    assert.ok(minutes > 0, "Should return positive minutes");
  });

  it("should return faster time for rideshare than walk", () => {
    const from = { lat: 40.7589, lng: -73.9851 };
    const to = { lat: 40.7800, lng: -73.9600 };

    const walkMinutes = calculator.calculateMinutes(from, to, "walk");
    const rideshareMinutes = calculator.calculateMinutes(from, to, "rideshare");

    assert.ok(
      rideshareMinutes < walkMinutes,
      "Rideshare should be faster than walking"
    );
  });

  it("should handle zero distance", () => {
    const from = { lat: 40.7589, lng: -73.9851 };
    const to = { lat: 40.7589, lng: -73.9851 };

    const minutes = calculator.calculateMinutes(from, to, "walk");

    assert.equal(minutes, 0, "Zero distance should return 0 minutes");
  });

  it("should handle very long distance", () => {
    const from = { lat: 40.7589, lng: -73.9851 };
    const to = { lat: 40.8589, lng: -74.0851 };

    const minutes = calculator.calculateMinutes(from, to, "walk");

    assert.ok(minutes > 60, "Long distance should take over 60 minutes");
  });

  it("should apply detour factor consistently", () => {
    const from = { lat: 40.7589, lng: -73.9851 };
    const to = { lat: 40.7600, lng: -73.9860 };

    const minutes1 = calculator.calculateMinutes(from, to, "walk");
    const minutes2 = calculator.calculateMinutes(from, to, "walk");

    assert.equal(
      minutes1,
      minutes2,
      "Deterministic calculation should return same result"
    );
  });

  it("should ceil fractional minutes", () => {
    const from = { lat: 40.7589, lng: -73.9851 };
    const to = { lat: 40.7589, lng: -73.9852 };

    const minutes = calculator.calculateMinutes(from, to, "walk");

    assert.equal(
      minutes % 1,
      0,
      "Should return whole number of minutes"
    );
  });

  it("should handle NYC typical distances", () => {
    const timesSquare = { lat: 40.7580, lng: -73.9855 };
    const centralPark = { lat: 40.7829, lng: -73.9654 };

    const walkMinutes = calculator.calculateMinutes(
      timesSquare,
      centralPark,
      "walk"
    );
    const transitMinutes = calculator.calculateMinutes(
      timesSquare,
      centralPark,
      "transit"
    );
    const rideshareMinutes = calculator.calculateMinutes(
      timesSquare,
      centralPark,
      "rideshare"
    );

    assert.ok(
      walkMinutes > 30,
      "Times Square to Central Park walk should be over 30 min"
    );
    assert.ok(
      transitMinutes < walkMinutes,
      "Transit should be faster than walk"
    );
    assert.ok(
      rideshareMinutes < walkMinutes,
      "Rideshare should be faster than walk"
    );
  });

  it("should handle negative longitude differences", () => {
    const east = { lat: 40.7589, lng: -73.9851 };
    const west = { lat: 40.7589, lng: -74.0051 };

    const minutes = calculator.calculateMinutes(east, west, "walk");

    assert.ok(minutes > 0, "Should handle longitude direction");
  });

  it("should handle negative latitude differences", () => {
    const north = { lat: 40.7789, lng: -73.9851 };
    const south = { lat: 40.7389, lng: -73.9851 };

    const minutes = calculator.calculateMinutes(north, south, "walk");

    assert.ok(minutes > 0, "Should handle latitude direction");
  });
});
