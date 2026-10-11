import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { candidateSchema } from "../../src/validation/candidate";
import { allCandidates, createRetrievalDeps, retrieveForTool } from "../../src/retrieval";

/** Bills one real Text Search ($0.035). Opt in with RUN_LIVE_PLACES=1 and a key. */
const isLiveEnabled = process.env.RUN_LIVE_PLACES === "1" && Boolean(process.env.GOOGLE_PLACES_API_KEY);

describe("live Places smoke", () => {
  it("one real search returns strict candidates for an NYC dessert query", { skip: !isLiveEnabled }, async () => {
    const openAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    openAt.setUTCHours(0, 0, 0, 0);
    const result = await retrieveForTool(
      {
        tool: "search_venues",
        area: "West Village",
        category: "dessert",
        priceLevel: "PRICE_LEVEL_UNSPECIFIED",
        openAt: openAt.toISOString(),
      },
      undefined,
      createRetrievalDeps(),
    );
    assert.equal(result.placesRequests, 1);
    const candidates = allCandidates(result);
    assert.ok(candidates.length > 0, `no candidates: ${JSON.stringify([...result.byStopType])}`);
    for (const candidate of candidates) {
      candidateSchema.parse(candidate);
      assert.equal(candidate.businessStatus, "OPERATIONAL");
    }
  });
});
