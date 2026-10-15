import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createItineraryViewHandler } from "../../src/api/itinerary-view";
import { createMemorySpendRedis, createSpendStore } from "../../src/monitoring/spend-store";

describe("itinerary view handler", () => {
  it("returns not_found for a non-uuid id without touching the database", async () => {
    let loads = 0;
    const handler = createItineraryViewHandler({
      load: async () => {
        loads += 1;
        return null;
      },
      lookup: { lookup: async () => new Map() },
      store: createSpendStore(createMemorySpendRedis()),
    });
    const response = await handler(new Request("http://localhost/"), "not-a-uuid");
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not_found" });
    assert.equal(loads, 0);
  });
});
