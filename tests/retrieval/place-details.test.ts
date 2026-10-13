import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePlaceDetails } from "../../src/retrieval";

describe("parsePlaceDetails", () => {
  it("reads a live name and drops a body without one", () => {
    assert.deepEqual(
      parsePlaceDetails({
        id: "ChIJbar0",
        displayName: { text: "Little Branch" },
        formattedAddress: "20 7th Avenue",
        rating: 4.4,
        priceLevel: "PRICE_LEVEL_MODERATE",
      }),
      {
        placeId: "ChIJbar0",
        name: "Little Branch",
        formattedAddress: "20 7th Avenue",
        rating: 4.4,
        priceLevel: "PRICE_LEVEL_MODERATE",
      },
    );
    assert.equal(parsePlaceDetails({ id: "ChIJbar0" }), null);
  });
});
