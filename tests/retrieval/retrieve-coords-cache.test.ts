import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  allCandidates,
  coordsTtlDays,
  createMemoryCoordsCache,
  queryFromIntent,
  retrieveVenues,
  type CoordsCache,
  type CoordsObservation,
} from "../../src/retrieval";
import { DEFAULT_PRICE_RANGES } from "../../src/validation/defaults";
import type { Intent } from "../../src/validation/intent";
import { fakePlaces } from "./fake-places";
import { loadPlacesFixture } from "./places-fixtures";

const full = loadPlacesFixture("combined-drinks-dinner-dessert");

const intent: Intent = {
  area: "West Village",
  window: { start: "2026-10-16T19:00:00-04:00", end: "2026-10-17T01:00:00-04:00" },
  budgetUsd: 200,
  dietary: [],
  vibeTags: ["Cozy", "cocktail"],
  stopTypes: ["drinks", "dinner", "dessert"],
  singleStop: false,
};
const query = queryFromIntent(intent, { priceRanges: DEFAULT_PRICE_RANGES, partySize: 2 });

const DAY_MS = 24 * 60 * 60 * 1000;
const t0 = new Date("2026-10-01T00:00:00Z");
const cachedCoords = { lat: 1.5, lng: 2.5 };

function spyCache(inner: CoordsCache) {
  const recorded: CoordsObservation[] = [];
  const cache: CoordsCache = {
    read: (ids, now) => inner.read(ids, now),
    record: async (observations, now) => {
      recorded.push(...observations);
      await inner.record(observations, now);
    },
  };
  return { cache, recorded };
}

async function liveCandidates() {
  return allCandidates(await retrieveVenues(query, fakePlaces({ combined: [full] }).deps));
}

async function retrieveAt(now: Date, cache: CoordsCache) {
  const fake = fakePlaces({ combined: [full] });
  return allCandidates(await retrieveVenues(query, { ...fake.deps, coordsCache: cache, now: () => now }));
}

/** A cache holding `cachedCoords` for the first live candidate, fetched at t0. */
async function seeded() {
  const [target] = await liveCandidates();
  const inner = createMemoryCoordsCache(coordsTtlDays(30));
  await inner.record([{ placeId: target.placeId, coords: cachedCoords }], t0);
  return { target, ...spyCache(inner) };
}

describe("retrieveVenues coords cache", () => {
  it("serves a fresh cached coordinate and keeps the live name, rating, and hours", async () => {
    const { target, cache, recorded } = await seeded();
    const served = (await retrieveAt(new Date(t0.getTime() + 30 * DAY_MS - 1), cache)).find(
      (candidate) => candidate.placeId === target.placeId,
    );
    assert.deepEqual(served, { ...target, location: cachedCoords });
    assert.equal(recorded.some((entry) => entry.placeId === target.placeId), false);
  });

  it("does not serve a coordinate at expiresAt: uses the live value and re-caches it", async () => {
    const { target, cache, recorded } = await seeded();
    const expiredAt = new Date(t0.getTime() + 30 * DAY_MS);
    const served = (await retrieveAt(expiredAt, cache)).find((candidate) => candidate.placeId === target.placeId);
    assert.deepEqual(served?.location, target.location);
    assert.deepEqual(recorded.find((entry) => entry.placeId === target.placeId)?.coords, target.location);
    const next = new Date(expiredAt.getTime() + DAY_MS);
    assert.deepEqual((await cache.read([target.placeId], next)).get(target.placeId), target.location);
  });

  it("caches every returned place_id with coords only", async () => {
    const { cache, recorded } = spyCache(createMemoryCoordsCache(coordsTtlDays(30)));
    const ids = (await retrieveAt(t0, cache)).map((candidate) => candidate.placeId);
    assert.deepEqual(recorded.map((entry) => entry.placeId).sort(), [...new Set(ids)].sort());
    for (const entry of recorded) assert.deepEqual(Object.keys(entry).sort(), ["coords", "placeId"]);
    assert.equal((await cache.read(ids, t0)).size, new Set(ids).size);
  });

  it("a second retrieval within the TTL records nothing new", async () => {
    const { cache, recorded } = spyCache(createMemoryCoordsCache(coordsTtlDays(30)));
    await retrieveAt(t0, cache);
    const before = recorded.length;
    await retrieveAt(new Date(t0.getTime() + DAY_MS), cache);
    assert.equal(recorded.length, before);
  });

  it("a failing cache degrades to live coordinates", async () => {
    const broken: CoordsCache = {
      read: async () => {
        throw new Error("db down");
      },
      record: async () => {
        throw new Error("db down");
      },
    };
    assert.deepEqual(await retrieveAt(t0, broken), await liveCandidates());
  });
});
