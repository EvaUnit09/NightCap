import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  ROUTES_ESSENTIALS_FIELD_MASK,
  ROUTES_MATRIX_URL,
  RoutesMatrixTravelCalculator,
} from "../../src/validation/routes-travel";
import {
  TravelServiceUnavailableError,
  type TravelLeg,
} from "../../src/validation/travel";

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
  mode: "WALK",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("RoutesMatrixTravelCalculator", () => {
  it("never calls the live Routes URL from these tests", async () => {
    assert.equal(process.env.ENABLE_LIVE_ROUTES, undefined);
  });

  it("sends a 1×1 Essentials matrix per leg with no routingPreference", async () => {
    let calls = 0;
    let request: RequestInit | undefined;
    const calculator = new RoutesMatrixTravelCalculator({
      apiKey: "test-key",
      fetchImpl: async (url, init) => {
        calls += 1;
        request = init;
        assert.equal(String(url), ROUTES_MATRIX_URL);
        const body = JSON.parse(String(init?.body));
        assert.equal(body.origins.length, 1);
        assert.equal(body.destinations.length, 1);
        return jsonResponse(success);
      },
    });

    const otherWalk: TravelLeg = {
      ...walkLeg,
      to: { lat: 40.741, lng: -73.99 },
    };
    const result = await calculator.calculateMinutes([walkLeg, otherWalk]);
    assert.equal(calls, 2);
    assert.equal(request?.method, "POST");
    const headers = new Headers(request?.headers);
    assert.equal(headers.get("X-Goog-Api-Key"), "test-key");
    assert.equal(headers.get("X-Goog-FieldMask"), ROUTES_ESSENTIALS_FIELD_MASK);
    const body = JSON.parse(String(request?.body));
    assert.equal(body.travelMode, "WALK");
    assert.equal(body.routingPreference, undefined);
    assert.equal(result[0], 10);
    assert.equal(result[1], 10);
  });

  it("fails closed on lowercase walk, transit, and bicycle without fetching", async () => {
    let calls = 0;
    const calculator = new RoutesMatrixTravelCalculator({
      apiKey: "test-key",
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(success);
      },
    });
    const result = await calculator.calculateMinutes([
      { ...walkLeg, mode: "walk" },
      { ...walkLeg, mode: "transit" },
      { ...walkLeg, mode: "bicycle" },
    ]);
    assert.equal(calls, 0);
    assert.deepEqual(result, [null, null, null]);
  });

  it("sends identity travel modes WALK, TRANSIT, and BICYCLE", async () => {
    const modes: string[] = [];
    const calculator = new RoutesMatrixTravelCalculator({
      apiKey: "test-key",
      fetchImpl: async (_url, init) => {
        modes.push(JSON.parse(String(init?.body)).travelMode);
        return jsonResponse(success);
      },
    });
    await calculator.calculateMinutes([
      { ...walkLeg, mode: "WALK" },
      { ...walkLeg, mode: "TRANSIT" },
      { ...walkLeg, mode: "BICYCLE" },
    ]);
    assert.deepEqual(modes.sort(), ["BICYCLE", "TRANSIT", "WALK"]);
  });

  it("fails closed on rideshare, drive, and taxi without fetching", async () => {
    let calls = 0;
    const calculator = new RoutesMatrixTravelCalculator({
      apiKey: "test-key",
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(success);
      },
    });
    const result = await calculator.calculateMinutes([
      { ...walkLeg, mode: "rideshare" },
      { ...walkLeg, mode: "drive" },
      { ...walkLeg, mode: "taxi" },
    ]);
    assert.equal(calls, 0);
    assert.deepEqual(result, [null, null, null]);
  });

  it("throws travel_service_unavailable when the API key is missing and does not fetch", async () => {
    let calls = 0;
    const calculator = new RoutesMatrixTravelCalculator({
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(success);
      },
    });
    await assert.rejects(
      () => calculator.calculateMinutes([walkLeg]),
      (error: unknown) => {
        assert.ok(error instanceof TravelServiceUnavailableError);
        return true;
      }
    );
    assert.equal(calls, 0);
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

  it("throws travel_service_unavailable on HTTP 4xx/5xx", async () => {
    const calculator = new RoutesMatrixTravelCalculator({
      apiKey: "test-key",
      fetchImpl: async () => jsonResponse({ error: "no" }, 403),
    });
    await assert.rejects(
      () => calculator.calculateMinutes([walkLeg]),
      (error: unknown) => {
        assert.ok(error instanceof TravelServiceUnavailableError);
        return true;
      }
    );
  });

  it("throws travel_service_unavailable on timeout", async () => {
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
    await assert.rejects(
      () => calculator.calculateMinutes([walkLeg]),
      (error: unknown) => {
        assert.ok(error instanceof TravelServiceUnavailableError);
        return true;
      }
    );
  });

  it("aborts in-flight fetches when the caller signal is aborted", async () => {
    const controller = new AbortController();
    let aborted = false;
    const calculator = new RoutesMatrixTravelCalculator({
      apiKey: "test-key",
      fetchImpl: async (_url, init) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
      },
    });
    const pending = calculator.calculateMinutes([walkLeg], controller.signal);
    controller.abort();
    await assert.rejects(() => pending, TravelServiceUnavailableError);
    assert.equal(aborted, true);
  });

  it("rejects maxLegs that is <= 0 or NaN", () => {
    for (const maxLegs of [0, -1, Number.NaN]) {
      assert.throws(
        () => new RoutesMatrixTravelCalculator({ maxLegs }),
        /maxLegs/
      );
    }
  });

  it("bills one matrix element per consecutive leg across mixed modes (4 legs bill 4)", async () => {
    let billedElements = 0;
    const modesSent: string[] = [];
    const calculator = new RoutesMatrixTravelCalculator({
      apiKey: "test-key",
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        billedElements += body.origins.length * body.destinations.length;
        modesSent.push(body.travelMode);
        assert.equal(body.origins.length, 1);
        assert.equal(body.destinations.length, 1);
        return jsonResponse([
          {
            originIndex: 0,
            destinationIndex: 0,
            status: {},
            duration: "600s",
            condition: "ROUTE_EXISTS",
          },
        ]);
      },
    });
    const cycle = ["WALK", "TRANSIT", "BICYCLE"] as const;
    const legs = Array.from({ length: 4 }, (_, index) => ({
      ...walkLeg,
      mode: cycle[index % 3]!,
      from: { lat: 40.73 + index * 0.001, lng: -74.002 },
      to: { lat: 40.74 + index * 0.001, lng: -73.99 },
    }));
    const result = await calculator.calculateMinutes(legs);
    assert.equal(billedElements, 4);
    assert.equal(result.length, 4);
    assert.ok(result.every((minutes) => minutes === 10));
    assert.deepEqual(new Set(modesSent), new Set(["WALK", "TRANSIT", "BICYCLE"]));
  });

  it("refuses to bill 5 legs and never fetches", async () => {
    let calls = 0;
    const calculator = new RoutesMatrixTravelCalculator({
      apiKey: "test-key",
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(success);
      },
    });
    const legs = Array.from({ length: 5 }, (_, index) => ({
      ...walkLeg,
      from: { lat: 40.73 + index * 0.001, lng: -74.002 },
      to: { lat: 40.74 + index * 0.001, lng: -73.99 },
    }));
    await assert.rejects(
      () => calculator.calculateMinutes(legs),
      /At most 4 travel legs/
    );
    assert.equal(calls, 0);
  });

  it("sends a past departureTime only on TRANSIT and never on BICYCLE or WALK", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const calculator = new RoutesMatrixTravelCalculator({
      apiKey: "test-key",
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse([
          {
            originIndex: 0,
            destinationIndex: 0,
            status: {},
            duration: "600s",
            condition: "ROUTE_EXISTS",
          },
        ]);
      },
    });
    const pastDeparture = "2020-03-15T19:30:00-04:00";
    await calculator.calculateMinutes([
      { ...walkLeg, mode: "WALK", departureTime: pastDeparture },
      { ...walkLeg, mode: "TRANSIT", departureTime: pastDeparture },
      { ...walkLeg, mode: "BICYCLE", departureTime: pastDeparture },
    ]);
    const byMode = Object.fromEntries(
      bodies.map((body) => [body.travelMode, body])
    ) as Record<string, { departureTime?: string }>;
    assert.equal(byMode.TRANSIT?.departureTime, pastDeparture);
    assert.equal(byMode.WALK?.departureTime, undefined);
    assert.equal(byMode.BICYCLE?.departureTime, undefined);
  });

  it("memos identical legs within one calculateMinutes call", async () => {
    let calls = 0;
    const calculator = new RoutesMatrixTravelCalculator({
      apiKey: "test-key",
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse([
          {
            originIndex: 0,
            destinationIndex: 0,
            status: {},
            duration: "600s",
            condition: "ROUTE_EXISTS",
          },
        ]);
      },
    });
    const result = await calculator.calculateMinutes([walkLeg, walkLeg, walkLeg]);
    assert.equal(calls, 1);
    assert.deepEqual(result, [10, 10, 10]);
  });

  it("does not reuse the in-call memo across calculateMinutes calls", async () => {
    let calls = 0;
    const calculator = new RoutesMatrixTravelCalculator({
      apiKey: "test-key",
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(success);
      },
    });
    await calculator.calculateMinutes([walkLeg]);
    await calculator.calculateMinutes([walkLeg]);
    assert.equal(calls, 2);
  });

  it("sends departureTime for TRANSIT only and omits it for WALK and BICYCLE", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const calculator = new RoutesMatrixTravelCalculator({
      apiKey: "test-key",
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse([
          {
            originIndex: 0,
            destinationIndex: 0,
            status: {},
            duration: "600s",
            condition: "ROUTE_EXISTS",
          },
        ]);
      },
    });
    const departureTime = "2026-10-15T20:00:00-04:00";
    await calculator.calculateMinutes([
      { ...walkLeg, mode: "WALK", departureTime },
      { ...walkLeg, mode: "TRANSIT", departureTime },
      { ...walkLeg, mode: "BICYCLE", departureTime },
    ]);
    const byMode = Object.fromEntries(
      bodies.map((body) => [body.travelMode, body])
    ) as Record<string, { departureTime?: string; routingPreference?: string }>;
    assert.equal(byMode.WALK?.departureTime, undefined);
    assert.equal(byMode.TRANSIT?.departureTime, departureTime);
    assert.equal(byMode.BICYCLE?.departureTime, undefined);
    assert.equal(byMode.WALK?.routingPreference, undefined);
    assert.equal(byMode.TRANSIT?.routingPreference, undefined);
    assert.equal(byMode.BICYCLE?.routingPreference, undefined);
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
      { from: null, to: walkLeg.to, mode: "WALK" },
      walkLeg,
    ]);
    assert.equal(originCount, 1);
    assert.equal(result[0], null);
    assert.equal(result[1], 10);
  });
});
