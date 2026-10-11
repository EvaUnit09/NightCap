import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { resetConfig } from "../../src/models";
import { allCandidates, createRetrievalDeps, retrieveForIntent, retrieveForTool } from "../../src/retrieval";
import { jsonResponse, loadPlacesFixture } from "./places-fixtures";

const originalEnv = { ...process.env };

function countingFetch(body: unknown) {
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    seen.push(String(new Headers(init?.headers).get("X-Goog-Api-Key")));
    return jsonResponse(body);
  };
  return { fetchImpl, seen };
}

describe("retrieval server entry points", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
  });

  it("a missing Places key is a gap per stop with zero fetches, not a throw", async () => {
    delete process.env.GOOGLE_PLACES_API_KEY;
    resetConfig();
    const { fetchImpl, seen } = countingFetch({});
    const result = await retrieveForIntent(
      {
        area: "SoHo",
        window: { start: "2026-10-16T19:00:00-04:00", end: "2026-10-16T23:00:00-04:00" },
        budgetUsd: 120,
        dietary: [],
        vibeTags: [],
        stopTypes: ["dinner", "bar"],
        singleStop: false,
      },
      undefined,
      createRetrievalDeps({ fetchImpl }),
    );
    assert.equal(seen.length, 0);
    assert.deepEqual([...result.byStopType.values()], [
      { kind: "gap", reason: "places_unavailable" },
      { kind: "gap", reason: "places_unavailable" },
    ]);
  });

  it("search_venues runs on config settings with the configured key", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "configured-key";
    process.env.RETRIEVAL_TOP_K = "2";
    process.env.RETRIEVAL_MIN_PER_STOP = "1";
    resetConfig();
    const { fetchImpl, seen } = countingFetch(loadPlacesFixture("refill-dessert"));
    const result = await retrieveForTool(
      { tool: "search_venues", area: "SoHo", category: "dessert", priceLevel: "PRICE_LEVEL_INEXPENSIVE", openAt: "2026-10-16T20:00:00-04:00" },
      undefined,
      createRetrievalDeps({ fetchImpl }),
    );
    assert.deepEqual(seen, ["configured-key"]);
    assert.equal(allCandidates(result).length, 2);
  });
});
