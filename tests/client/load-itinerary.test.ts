import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadItinerary } from "../../src/client/load-itinerary";

const ID = "11111111-1111-4111-8111-111111111111";

describe("load itinerary view", () => {
  it("returns hydrated names from a 200 view", async () => {
    const fetchImpl = async () =>
      Response.json({
        id: ID,
        stops: [
          {
            placeId: "ChIJbar0",
            name: "Little Branch",
            why: "Quiet room",
            start: "2026-10-16T19:00:00-04:00",
          },
        ],
      });

    assert.deepEqual(await loadItinerary(ID, { fetchImpl }), {
      kind: "ready",
      id: ID,
      stops: [
        {
          placeId: "ChIJbar0",
          name: "Little Branch",
          why: "Quiet room",
          start: "2026-10-16T19:00:00-04:00",
        },
      ],
    });
  });

  it("returns missing when the view is not found", async () => {
    const fetchImpl = async () => Response.json({ error: "not_found" }, { status: 404 });
    assert.deepEqual(await loadItinerary(ID, { fetchImpl }), { kind: "missing" });
  });

  it("returns missing when a stop has no place id", async () => {
    const fetchImpl = async () =>
      Response.json({
        id: ID,
        stops: [{ name: "Little Branch", why: "Quiet room", start: "2026-10-16T19:00:00-04:00" }],
      });
    assert.deepEqual(await loadItinerary(ID, { fetchImpl }), { kind: "missing" });
  });
});
