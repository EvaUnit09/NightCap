import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { createMapCoordsHandler } from "../../../src/api/map-coords";
import { loadStopCoords } from "../../../src/client/load-stop-coords";
import {
  clampSelection,
  mapOptionsForScreen,
  markersFromStops,
  stopsForSelection,
} from "../../../src/client/map-markers";
import type { ItineraryOption } from "../../../src/validation/itinerary";

const STOPS = [
  { placeId: "ChIJbar", label: "Little Branch" },
  { placeId: "ChIJmiss", label: "Missing" },
  { placeId: "ChIJdinner", label: "Via Carota" },
] as const;

const COORDS = [
  { placeId: "ChIJdinner", lat: 40.73, lng: -74.0 },
  { placeId: "ChIJbar", lat: 40.71, lng: -74.01 },
] as const;

function option(theme: string, first: string, second: string): ItineraryOption {
  return {
    theme,
    stops: [
      {
        placeId: first,
        name: first,
        start: "2026-10-16T19:00:00-04:00",
        end: "2026-10-16T20:00:00-04:00",
        estimatedCostUsd: 40,
        why: "Fits a cozy night",
        travelToNext: { mode: "WALK", minutes: 10 },
      },
      {
        placeId: second,
        name: second,
        start: "2026-10-16T20:15:00-04:00",
        end: "2026-10-16T22:00:00-04:00",
        estimatedCostUsd: 80,
        why: "Fits a cozy night",
        travelToNext: null,
      },
    ],
  };
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/map-coords", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("map markers", () => {
  it("keeps itinerary order and skips a stop with no coordinates", () => {
    assert.deepEqual(markersFromStops(STOPS, COORDS), [
      { placeId: "ChIJbar", label: "Little Branch", order: 1, lat: 40.71, lng: -74.01 },
      { placeId: "ChIJdinner", label: "Via Carota", order: 3, lat: 40.73, lng: -74.0 },
    ]);
  });

  it("drops a coordinate that is not finite", () => {
    assert.deepEqual(
      markersFromStops([{ placeId: "ChIJbar", label: "Little Branch" }], [{ placeId: "ChIJbar", lat: Number.NaN, lng: 1 }]),
      [],
    );
  });

  it("uses only the selected itinerary", () => {
    const options = [
      { stops: [{ placeId: "a", name: "A" }] },
      { stops: [{ placeId: "b", name: "B" }, { placeId: "c", name: "C" }] },
    ];
    assert.deepEqual(stopsForSelection(options, 1), [
      { placeId: "b", label: "B" },
      { placeId: "c", label: "C" },
    ]);
    assert.deepEqual(stopsForSelection(options, 9), [
      { placeId: "b", label: "B" },
      { placeId: "c", label: "C" },
    ]);
    assert.equal(clampSelection(-1, 2), 0);
    assert.deepEqual(stopsForSelection([], 0), []);
  });

  it("reads streamed options and a reloaded plan", () => {
    const first = option("Quiet", "place-a", "place-b");
    const second = option("Loud", "place-c", "place-d");
    assert.deepEqual(
      mapOptionsForScreen({ phase: "ready", intent: null, options: [first, second], itineraryIds: [] }),
      [
        {
          stops: [
            { placeId: "place-a", name: "place-a" },
            { placeId: "place-b", name: "place-b" },
          ],
        },
        {
          stops: [
            { placeId: "place-c", name: "place-c" },
            { placeId: "place-d", name: "place-d" },
          ],
        },
      ],
    );
    assert.deepEqual(
      mapOptionsForScreen({
        phase: "reloaded",
        id: "11111111-1111-4111-8111-111111111111",
        stops: [{ placeId: "place-a", name: null, why: "Fits a cozy night", start: "2026-10-16T19:00:00-04:00" }],
      }),
      [{ stops: [{ placeId: "place-a", name: "place-a" }] }],
    );
    assert.deepEqual(mapOptionsForScreen({ phase: "idle" }), []);
  });
});

describe("POST /api/map-coords", () => {
  it("returns live cache hits and omits the rest", async () => {
    const handler = createMapCoordsHandler(async () => new Map([["ChIJbar", { lat: 40.71, lng: -74.01 }]]));
    const response = await handler(post({ placeIds: ["ChIJbar", "ChIJmiss", "ChIJbar"] }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { coords: [{ placeId: "ChIJbar", lat: 40.71, lng: -74.01 }] });
  });

  it("returns an empty list when the cache read fails", async () => {
    const handler = createMapCoordsHandler(async () => {
      throw new Error("db down");
    });
    const response = await handler(post({ placeIds: ["ChIJbar"] }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { coords: [] });
  });

  it("rejects a body that is not the place id list", async () => {
    const handler = createMapCoordsHandler(async () => new Map());
    assert.equal((await handler(post("{"))).status, 400);
    assert.equal((await handler(post({ placeIds: ["ok"], extra: true }))).status, 400);
    assert.deepEqual(await (await handler(post({ placeIds: [] }))).json(), { coords: [] });
  });
});

describe("loadStopCoords", () => {
  it("returns the coordinates from a 200 body", async () => {
    const coords = await loadStopCoords(["ChIJbar"], {
      fetchImpl: async () => Response.json({ coords: [{ placeId: "ChIJbar", lat: 40.71, lng: -74.01 }] }),
    });
    assert.deepEqual(coords, [{ placeId: "ChIJbar", lat: 40.71, lng: -74.01 }]);
  });

  it("returns nothing when the response is unusable", async () => {
    assert.deepEqual(await loadStopCoords([], {}), []);
    assert.deepEqual(
      await loadStopCoords(["ChIJbar"], { fetchImpl: async () => new Response("no", { status: 500 }) }),
      [],
    );
    assert.deepEqual(
      await loadStopCoords(["ChIJbar"], { fetchImpl: async () => Response.json({ places: [] }) }),
      [],
    );
  });
});

describe("maps key separation", () => {
  it("keeps the Places server key out of the browser map files", () => {
    const files = [
      "app/route-map.tsx",
      "app/request-screen.tsx",
      "src/client/map-markers.ts",
      "src/client/load-stop-coords.ts",
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      assert.equal(source.includes("GOOGLE_PLACES_API_KEY"), false, file);
    }
    const map = readFileSync("app/route-map.tsx", "utf8");
    assert.equal(map.includes("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY"), true);
    const route = readFileSync("app/api/map-coords/route.ts", "utf8");
    assert.equal(route.includes("GOOGLE_PLACES_API_KEY"), false);
    assert.equal(route.includes("createPlacesCoordsCache"), true);
  });
});
