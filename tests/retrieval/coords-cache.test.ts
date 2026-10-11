import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  coordsTtlDays,
  createMemoryCoordsCache,
  isLive,
  planCoordsWrite,
  type CoordsEntry,
} from "../../src/retrieval/coords-cache";

const DAY_MS = 24 * 60 * 60 * 1000;
const t0 = new Date("2026-10-01T00:00:00Z");
const here = { lat: 40.7359, lng: -74.0036 };
const moved = { lat: 40.7361, lng: -74.0036 };

function entry(fetchedAt: Date, days: number, coords = here): CoordsEntry {
  return {
    placeId: "p1",
    coords,
    fetchedAt,
    expiresAt: new Date(fetchedAt.getTime() + days * DAY_MS),
  };
}

describe("coords cache TTL", () => {
  it("serves an entry 1 ms before expiresAt and not at expiresAt", async () => {
    const cache = createMemoryCoordsCache(coordsTtlDays(30));
    await cache.record([{ placeId: "p1", coords: here }], t0);
    const expiresAt = t0.getTime() + 30 * DAY_MS;
    const before = await cache.read(["p1"], new Date(expiresAt - 1));
    const at = await cache.read(["p1"], new Date(expiresAt));
    assert.deepEqual(before.get("p1"), here);
    assert.equal(at.has("p1"), false);
  });

  it("isLive is strict at the boundary", () => {
    const e = entry(t0, 1);
    assert.equal(isLive(e, new Date(e.expiresAt.getTime() - 1)), true);
    assert.equal(isLive(e, e.expiresAt), false);
  });

  it("refuses a TTL outside 1..30 whole days", () => {
    assert.throws(() => coordsTtlDays(31), RangeError);
    assert.throws(() => coordsTtlDays(0), RangeError);
    assert.throws(() => coordsTtlDays(1.5), RangeError);
    assert.equal(coordsTtlDays(30), 30);
  });
});

describe("planCoordsWrite", () => {
  const ttl = coordsTtlDays(30);
  const later = new Date(t0.getTime() + DAY_MS);
  const afterExpiry = new Date(t0.getTime() + 31 * DAY_MS);

  it("inserts an absent place with a 30-day expiry", () => {
    assert.deepEqual(planCoordsWrite(undefined, { placeId: "p1", coords: here }, t0, ttl), {
      kind: "insert",
      entry: entry(t0, 30),
    });
  });

  it("keeps a live entry with the same coords", () => {
    assert.deepEqual(planCoordsWrite(entry(t0, 30), { placeId: "p1", coords: here }, later, ttl), {
      kind: "keep",
    });
  });

  it("replaces an expired entry with the same coords", () => {
    assert.deepEqual(
      planCoordsWrite(entry(t0, 30), { placeId: "p1", coords: here }, afterExpiry, ttl),
      { kind: "replace", entry: entry(afterExpiry, 30) },
    );
  });

  it("replaces a live entry whose coords moved", () => {
    assert.deepEqual(planCoordsWrite(entry(t0, 30), { placeId: "p1", coords: moved }, later, ttl), {
      kind: "replace",
      entry: entry(later, 30, moved),
    });
  });

  it("recording the same observation twice leaves the first fetchedAt", async () => {
    const cache = createMemoryCoordsCache(ttl);
    await cache.record([{ placeId: "p1", coords: here }], t0);
    await cache.record([{ placeId: "p1", coords: here }], later);
    const justBeforeFirstExpiry = new Date(t0.getTime() + 30 * DAY_MS - 1);
    const atFirstExpiry = new Date(t0.getTime() + 30 * DAY_MS);
    assert.deepEqual((await cache.read(["p1"], justBeforeFirstExpiry)).get("p1"), here);
    assert.equal((await cache.read(["p1"], atFirstExpiry)).has("p1"), false);
  });
});
