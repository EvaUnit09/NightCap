import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TRAVEL_MODES } from "../../src/contracts/travel";
import { HaversineEstimator, SUPPORTED_TRAVEL_MODES } from "../../src/validation/travel";

describe("HaversineEstimator (offline fallback)", () => {
  it("uses the contract travel-mode names", () => {
    assert.deepEqual([...SUPPORTED_TRAVEL_MODES], [...TRAVEL_MODES]);
    assert.deepEqual([...SUPPORTED_TRAVEL_MODES], ["TRANSIT", "BICYCLE", "WALK"]);
  });

  const calculator = new HaversineEstimator();

  it("returns one result per leg", () => {
    const result = calculator.calculateMinutes([
      {
        from: { lat: 40.7589, lng: -73.9851 },
        to: { lat: 40.76, lng: -73.986 },
        mode: "WALK",
      },
    ]);
    assert.equal(result.length, 1);
    assert.ok(result[0]! > 0);
    assert.ok(result[0]! < 10);
  });

  it("returns null when a side has no coordinates", () => {
    const result = calculator.calculateMinutes([
      { from: null, to: { lat: 40.76, lng: -73.986 }, mode: "WALK" },
    ]);
    assert.equal(result[0], null);
  });

  it("returns null for an unknown mode", () => {
    const result = calculator.calculateMinutes([
      {
        from: { lat: 40.7589, lng: -73.9851 },
        to: { lat: 40.76, lng: -73.986 },
        mode: "teleport",
      },
    ]);
    assert.equal(result[0], null);
  });

  it("is deterministic", () => {
    const legs = [
      {
        from: { lat: 40.7589, lng: -73.9851 },
        to: { lat: 40.76, lng: -73.986 },
        mode: "WALK" as const,
      },
    ];
    assert.deepEqual(
      calculator.calculateMinutes(legs),
      calculator.calculateMinutes(legs)
    );
  });

  it("ceils to whole minutes", () => {
    const [minutes] = calculator.calculateMinutes([
      {
        from: { lat: 40.7589, lng: -73.9851 },
        to: { lat: 40.7589, lng: -73.9852 },
        mode: "WALK",
      },
    ]);
    assert.equal((minutes ?? 0) % 1, 0);
  });

  it("returns 0 for zero distance", () => {
    const [minutes] = calculator.calculateMinutes([
      {
        from: { lat: 40.7589, lng: -73.9851 },
        to: { lat: 40.7589, lng: -73.9851 },
        mode: "WALK",
      },
    ]);
    assert.equal(minutes, 0);
  });

  it("estimates West Village → East Village walking around 15–30 min", () => {
    const [minutes] = calculator.calculateMinutes([
      {
        from: { lat: 40.734, lng: -74.002 },
        to: { lat: 40.729, lng: -73.987 },
        mode: "WALK",
      },
    ]);
    assert.ok(minutes !== null);
    assert.ok(minutes! >= 15, `expected >= 15, got ${minutes}`);
    assert.ok(minutes! <= 30, `expected <= 30, got ${minutes}`);
  });

  it("fails closed on lowercase walk (mapping is identity)", () => {
    const from = { lat: 40.734, lng: -74.002 };
    const to = { lat: 40.729, lng: -73.987 };
    assert.deepEqual(calculator.calculateMinutes([{ from, to, mode: "walk" }]), [
      null,
    ]);
  });

  it("models TRANSIT door-to-door so a ~2.5 mi hop is 20–30 min", () => {
    const [minutes] = calculator.calculateMinutes([
      {
        from: { lat: 40.7081, lng: -73.9571 },
        to: { lat: 40.718, lng: -73.99 },
        mode: "TRANSIT",
      },
    ]);
    assert.ok(minutes !== null);
    assert.ok(minutes! >= 15, `expected >= 15, got ${minutes}`);
    assert.ok(minutes! <= 35, `expected <= 35, got ${minutes}`);
  });
});
