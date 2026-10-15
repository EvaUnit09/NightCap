import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hydrateUnlessBlocked } from "../../src/monitoring/hydrate-plan";
import type { PlaceDetailsLookup } from "../../src/monitoring/hydrate-plan";
import { getRateLimitDailySpendUsd } from "../../src/models/config";
import { usdToMicros, utcDay } from "../../src/monitoring/spend-cap";
import { createMemorySpendRedis, createSpendStore, type SpendStore } from "../../src/monitoring/spend-store";
import type { StoredStop } from "../../src/monitoring/stored-stop";

const stops = [{ placeId: "p1" }] as unknown as StoredStop[];
const live: PlaceDetailsLookup = {
  lookup: async () =>
    new Map([["p1", { placeId: "p1", name: "Bar", formattedAddress: "1 St", rating: 4.5, priceLevel: "2" }]]),
};
const throwing: PlaceDetailsLookup = {
  lookup: async () => {
    throw new Error("boom");
  },
};

function freshStore(): SpendStore {
  return createSpendStore(createMemorySpendRedis());
}

async function cappedStore(): Promise<SpendStore> {
  const store = freshStore();
  await store.addDailyMicros(utcDay(Date.now()), usdToMicros(getRateLimitDailySpendUsd()));
  return store;
}

const downStore: SpendStore = {
  ...freshStore(),
  readDailyMicros: async () => {
    throw new Error("store down");
  },
};

describe("hydrateUnlessBlocked", () => {
  it("hydrates when not blocked", async () => {
    const out = await hydrateUnlessBlocked(stops, live, freshStore());
    assert.equal(out.hydrated, true);
    assert.equal(out.stops[0]?.name, "Bar");
  });

  const cases: ReadonlyArray<readonly [string, PlaceDetailsLookup, () => Promise<SpendStore>]> = [
    ["blocked", live, cappedStore],
    ["the cap check throws", live, async () => downStore],
    ["hydrate throws", throwing, async () => freshStore()],
  ];
  for (const [label, lookup, makeStore] of cases) {
    it(`returns bare stops when ${label}`, async () => {
      const out = await hydrateUnlessBlocked(stops, lookup, await makeStore());
      assert.equal(out.hydrated, false);
      assert.deepEqual(out.stops[0], { ...stops[0], name: null, formattedAddress: null, rating: null, priceLevel: null });
    });
  }
});
