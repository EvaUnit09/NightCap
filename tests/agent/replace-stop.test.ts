import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runReplaceStop } from "../../src/agent";
import type { Itinerary } from "../../src/validation/itinerary";
import { baseContext, sampleCandidate, sampleItinerary } from "./fixtures";

describe("replace_stop", () => {
  it("swaps a stop for an allowed place id from this turn", async () => {
    const itinerary = sampleItinerary();
    const replacement = sampleCandidate("ChIJ_new", "New Spot", "dinner");
    const result = await runReplaceStop(
      { tool: "replace_stop", optionIndex: 0, stopIndex: 0, placeId: "ChIJ_new" },
      baseContext({
        itinerary,
        allowedPlaceIds: new Set(["ChIJ_new"]),
        candidates: [...itinerary.options.flatMap((o) => o.stops.map((s) => sampleCandidate(s.placeId))), replacement],
      }),
    );
    assert.equal(result.is_error, false);
    if (result.is_error) return;
    const content = result.content as { itinerary: Itinerary };
    assert.equal(content.itinerary.options[0].stops[0].placeId, "ChIJ_new");
    assert.equal(content.itinerary.options[0].stops[0].name, "New Spot");
  });

  it("rejects an unknown place id not from this turn's search", async () => {
    const result = await runReplaceStop(
      { tool: "replace_stop", optionIndex: 0, stopIndex: 0, placeId: "invented" },
      baseContext({ allowedPlaceIds: new Set(["ChIJ_other"]) }),
    );
    assert.equal(result.is_error, true);
    if (!result.is_error) return;
    assert.equal(result.error.code, "unknown_place_id");
  });

  it("rejects an unknown optionIndex", async () => {
    const result = await runReplaceStop(
      { tool: "replace_stop", optionIndex: 2, stopIndex: 0, placeId: "place-a" },
      baseContext({ allowedPlaceIds: new Set(["place-a"]) }),
    );
    assert.equal(result.is_error, true);
    if (!result.is_error) return;
    assert.equal(result.error.code, "unknown_option");
  });

  it("rejects an unknown stopIndex", async () => {
    const result = await runReplaceStop(
      { tool: "replace_stop", optionIndex: 0, stopIndex: 3, placeId: "place-a" },
      baseContext({ allowedPlaceIds: new Set(["place-a"]) }),
    );
    assert.equal(result.is_error, true);
    if (!result.is_error) return;
    assert.equal(result.error.code, "unknown_stop");
  });
});
