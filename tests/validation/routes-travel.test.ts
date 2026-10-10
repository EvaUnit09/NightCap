import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  ROUTES_ESSENTIALS_FIELD_MASK,
  ROUTES_MATRIX_URL,
  RoutesMatrixTravelCalculator,
} from "../../src/validation/routes-travel";
import type { TravelLeg } from "../../src/validation/travel";

const success = JSON.parse(
  readFileSync(new URL("../fixtures/routes/success.json", import.meta.url), "utf8")
);
const notFound = JSON.parse(
  readFileSync(
    new URL("../fixtures/routes/route-not-found.json", import.meta.url),
    "utf8"
  )
);
const elementError = JSON.parse(
  readFileSync(
    new URL("../fixtures/routes/element-error.json", import.meta.url),
    "utf8"
  )
);

const walkLeg: TravelLeg = {
  from: { lat: 40.734, lng: -74.002 },
  to: { lat: 40.729, lng: -73.987 },
  mode: "walk",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("RoutesMatrixTravelCalculator", () => {
  it("batches same-mode legs into one matrix POST with Essentials field mask", async () => {
    let calls = 0;
    let request: RequestInit | undefined;
    const calculator = new RoutesMatrixTravelCalculator({
      apiKey: "test-key",
      fetchImpl: async (url, init) => {
        calls += 1;
        request = init;
        assert.equal(String(url), ROUTES_MATRIX_URL);
        return jsonResponse(success);
      },
    });

    const result = await calculator.calculateMinutes([walkLeg, walkLeg]);
    assert.equal(calls, 1);
    assert.equal(request?.method, "POST");
    const headers = new Headers(request?.headers);
    assert.equal(headers.get("X-Goog-Api-Key"), "test-key");
    assert.equal(headers.get("X-Goog-FieldMask"), ROUTES_ESSENTIALS_FIELD_MASK);
    const body = JSON.parse(String(request?.body));
    assert.equal(body.travelMode, "WALK");
    assert.equal(body.routingPreference, undefined);
    assert.equal(result[0], 10);
    assert.equal(result[1], 12);
  });

  it("maps rideshare to DRIVE and transit to TRANSIT", async () => {
    const modes: string[] = [];
    const calculator = new RoutesMatrixTravelCalculator({
      apiKey: "test-key",
      fetchImpl: async (_url, init) => {
        modes.push(JSON.parse(String(init?.body)).travelMode);
        return jsonResponse(success);
      },
    });
    await calculator.calculateMinutes([
      { ...walkLeg, mode: "rideshare" },
      { ...walkLeg, mode: "transit" },
    ]);
    assert.deepEqual(modes.sort(), ["DRIVE", "TRANSIT"]);
  });

  it("returns null when the API key is missing and does not fetch", async () => {
    let calls = 0;
    const calculator = new RoutesMatrixTravelCalculator({
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(success);
      },
    });
    const result = await calculator.calculateMinutes([walkLeg]);
    assert.equal(calls, 0);
    assert.equal(result[0], null);
  });

  it("fails closed on ROUTE_NOT_FOUND", async () => {
    const calculator = new RoutesMatrixTravelCalculator({
      apiKey: "test-key",
      fetchImpl: async () => jsonResponse(notFound),
    });
    const result = await calculator.calculateMinutes([walkLeg]);
    assert.equal(result[0], null);
  });

  it("fails closed on an element status error", async () => {
    const calculator = new RoutesMatrixTravelCalculator({
      apiKey: "test-key",
      fetchImpl: async () => jsonResponse(elementError),
    });
    const result = await calculator.calculateMinutes([walkLeg]);
    assert.equal(result[0], null);
  });

  it("fails closed on HTTP 4xx/5xx", async () => {
    const calculator = new RoutesMatrixTravelCalculator({
      apiKey: "test-key",
      fetchImpl: async () => jsonResponse({ error: "no" }, 403),
    });
    const result = await calculator.calculateMinutes([walkLeg]);
    assert.equal(result[0], null);
  });

  it("fails closed on timeout", async () => {
    const calculator = new RoutesMatrixTravelCalculator({
      apiKey: "test-key",
      timeoutMs: 10,
      fetchImpl: async (_url, init) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
      },
    });
    const result = await calculator.calculateMinutes([walkLeg]);
    assert.equal(result[0], null);
  });

  it("returns null for a leg with missing coordinates without calling fetch for it", async () => {
    let originCount = 0;
    const calculator = new RoutesMatrixTravelCalculator({
      apiKey: "test-key",
      fetchImpl: async (_url, init) => {
        originCount = JSON.parse(String(init?.body)).origins.length;
        return jsonResponse(success);
      },
    });
    const result = await calculator.calculateMinutes([
      { from: null, to: walkLeg.to, mode: "walk" },
      walkLeg,
    ]);
    assert.equal(originCount, 1);
    assert.equal(result[0], null);
    assert.equal(result[1], 10);
  });
});
