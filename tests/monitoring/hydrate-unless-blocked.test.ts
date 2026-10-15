import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hydrateUnlessBlocked } from "../../src/monitoring/hydrate-plan";
import type { PlaceDetailsLookup } from "../../src/monitoring/hydrate-plan";
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

describe("hydrateUnlessBlocked", () => {
  it("hydrates when not blocked", async () => {
    const out = await hydrateUnlessBlocked(stops, live, async () => false);
    assert.equal(out.hydrated, true);
    assert.equal(out.stops[0]?.name, "Bar");
  });

  const cases: ReadonlyArray<readonly [string, PlaceDetailsLookup, () => Promise<boolean>]> = [
    ["blocked", live, async () => true],
    ["the blocked check throws", live, async () => { throw new Error("store down"); }],
    ["hydrate throws", throwing, async () => false],
  ];
  for (const [label, lookup, blocked] of cases) {
    it(`returns bare stops when ${label}`, async () => {
      const out = await hydrateUnlessBlocked(stops, lookup, blocked);
      assert.equal(out.hydrated, false);
      assert.deepEqual(out.stops[0], { ...stops[0], name: null, formattedAddress: null, rating: null, priceLevel: null });
    });
  }
});
