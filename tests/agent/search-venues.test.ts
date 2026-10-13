import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runSearchVenues } from "../../src/agent";
import { retrieveForTool } from "../../src/retrieval";
import { fakePlaces } from "../retrieval/fake-places";
import { loadPlacesFixture } from "../retrieval/places-fixtures";
import { baseContext } from "./fixtures";

const INPUT = {
  tool: "search_venues" as const,
  area: "SoHo",
  category: "dessert" as const,
  priceLevel: "PRICE_LEVEL_INEXPENSIVE" as const,
  openAt: "2026-10-16T20:00:00-04:00",
};

describe("search_venues", () => {
  it("returns ranked candidates from the shared retrieval path", async () => {
    const fake = fakePlaces(
      { dessert_shop: [loadPlacesFixture("refill-dessert")] },
      { settings: { minPerStop: 1, maxSearches: 1, topK: 2 } },
    );
    const result = await runSearchVenues(
      INPUT,
      baseContext({
        retrieve: (input, signal) => retrieveForTool(input, signal, fake.deps),
      }),
    );
    assert.equal(result.is_error, false);
    if (result.is_error) return;
    const content = result.content as { candidates: readonly { placeId: string }[] };
    assert.ok(content.candidates.length >= 1);
    assert.ok(result.placesRequests !== undefined && result.placesRequests >= 1);
  });

  it("returns is_error when Places is rate limited", async () => {
    const fake = fakePlaces(
      { dessert_shop: [{ status: 429 }, { status: 429 }] },
      { settings: { maxSearches: 1, minPerStop: 1 } },
    );
    const result = await runSearchVenues(
      INPUT,
      baseContext({
        retrieve: (input, signal) => retrieveForTool(input, signal, fake.deps),
      }),
    );
    assert.equal(result.is_error, true);
    if (!result.is_error) return;
    assert.equal(result.error.code, "places_rate_limited");
  });

  it("returns is_error when Places times out", async () => {
    const fake = fakePlaces(
      { dessert_shop: ["hang", "hang"] },
      { settings: { maxSearches: 1, minPerStop: 1 } },
    );
    const result = await runSearchVenues(
      INPUT,
      baseContext({
        retrieve: (input, signal) => retrieveForTool(input, signal, fake.deps),
      }),
    );
    assert.equal(result.is_error, true);
    if (!result.is_error) return;
    assert.equal(result.error.code, "places_timeout");
  });

  it("returns an empty candidate list without is_error on no_matches", async () => {
    const fake = fakePlaces(
      { dessert_shop: [{ places: [] }] },
      { settings: { minPerStop: 1, maxSearches: 1 } },
    );
    const result = await runSearchVenues(
      INPUT,
      baseContext({
        retrieve: (input, signal) => retrieveForTool(input, signal, fake.deps),
      }),
    );
    assert.equal(result.is_error, false);
    if (result.is_error) return;
    const content = result.content as { candidates: readonly unknown[]; gapReason: string | null };
    assert.equal(content.candidates.length, 0);
    assert.equal(content.gapReason, "no_matches");
  });
});
