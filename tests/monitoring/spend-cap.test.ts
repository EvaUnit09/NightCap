import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  billableRoutesHops,
  clientIp,
  hourWindowMs,
  utcDay,
  vendorMicros,
} from "../../src/monitoring/spend-cap";
import {
  createMemorySpendRedis,
  createSpendStore,
  createSpendStoreFromEnv,
} from "../../src/monitoring/spend-store";

const DAY = "2026-10-12";
const T0 = Date.UTC(2026, 9, 12, 18, 0, 0);

describe("vendor spend", () => {
  it("sums model list price, one Text Search, and two Routes hops", () => {
    assert.equal(vendorMicros({ modelUsd: 0.0004, placesTextSearches: 1, routesHops: 2 }), 400 + 35_000 + 10_000);
  });

  it("counts a repeated walk once and skips a mode Routes will not bill", () => {
    const candidates = [
      { placeId: "a", location: { lat: 40.7, lng: -74 } },
      { placeId: "b", location: { lat: 40.71, lng: -74.01 } },
      { placeId: "c", location: { lat: 40.72, lng: -74.02 } },
    ];
    const itinerary = {
      options: [
        {
          stops: [
            { placeId: "a", end: "2026-10-16T20:00:00-04:00", travelToNext: { mode: "WALK", minutes: 10 } },
            { placeId: "b", travelToNext: null },
          ],
        },
        {
          stops: [
            { placeId: "a", end: "2026-10-16T20:00:00-04:00", travelToNext: { mode: "WALK", minutes: 12 } },
            { placeId: "b", end: "2026-10-16T21:00:00-04:00", travelToNext: { mode: "DRIVE", minutes: 8 } },
            { placeId: "c", travelToNext: null },
          ],
        },
      ],
    };

    assert.equal(billableRoutesHops({ itinerary, candidates }), 1);
  });

  it("keeps two transit hops apart when the departure differs", () => {
    const candidates = [
      { placeId: "a", location: { lat: 40.7, lng: -74 } },
      { placeId: "b", location: { lat: 40.71, lng: -74.01 } },
    ];
    const hop = (end: string) => ({
      stops: [
        { placeId: "a", end, travelToNext: { mode: "TRANSIT", minutes: 10 } },
        { placeId: "b", travelToNext: null },
      ],
    });

    assert.equal(
      billableRoutesHops({
        itinerary: { options: [hop("2026-10-16T20:00:00-04:00"), hop("2026-10-16T21:00:00-04:00")] },
        candidates,
      }),
      2,
    );
  });

  it("bills nothing when an end has no coordinates", () => {
    assert.equal(
      billableRoutesHops({
        itinerary: {
          options: [
            {
              stops: [
                { placeId: "a", travelToNext: { mode: "WALK", minutes: 10 } },
                { placeId: "missing", travelToNext: null },
              ],
            },
          ],
        },
        candidates: [{ placeId: "a", location: { lat: 40.7, lng: -74 } }],
      }),
      0,
    );
  });
});

describe("client address", () => {
  it("uses the first forwarded address", () => {
    const request = new Request("http://localhost/api/plan", {
      headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.4" },
    });
    assert.equal(clientIp(request), "203.0.113.9");
  });

  it("falls back to x-real-ip and then one shared bucket", () => {
    const real = new Request("http://localhost/api/plan", { headers: { "x-real-ip": "2001:db8::1" } });
    const blank = new Request("http://localhost/api/plan");
    assert.equal(clientIp(real), "2001:db8::1");
    assert.equal(clientIp(blank), "unknown");
  });
});

describe("spend store", () => {
  it("names the UTC day", () => {
    const midnight = Date.UTC(2026, 9, 12, 0, 0, 0);
    assert.equal(utcDay(midnight), DAY);
    assert.equal(utcDay(midnight - 1), "2026-10-11");
  });

  it("adds Places and Routes micros onto the same day key", async () => {
    const store = createSpendStore(createMemorySpendRedis());
    assert.equal(await store.readDailyMicros(DAY), 0);
    assert.equal(await store.addDailyMicros(DAY, 35_000), 35_000);
    assert.equal(await store.addDailyMicros(DAY, 5_000), 40_000);
    assert.equal(await store.addDailyMicros("2026-10-13", 5_000), 5_000);
    assert.equal(await store.readDailyMicros(DAY), 40_000);
  });

  it("refuses the sixth plan inside the hour and admits one after the window", async () => {
    const store = createSpendStore(createMemorySpendRedis());
    const ip = "203.0.113.10";
    for (let i = 0; i < 5; i += 1) {
      assert.equal(await store.recordPlan(ip, T0), i + 1);
    }
    assert.equal(await store.recordPlan(ip, T0), 6);

    const later = createSpendStore(createMemorySpendRedis());
    assert.equal(await later.recordPlan(ip, T0 + 1), 1);
    assert.equal(await later.recordPlan(ip, T0 + hourWindowMs()), 2);

    const expired = createSpendStore(createMemorySpendRedis());
    assert.equal(await expired.recordPlan(ip, T0), 1);
    assert.equal(await expired.recordPlan(ip, T0 + hourWindowMs()), 1);
  });

  it("keeps an empty Upstash config in memory and off any other store", async () => {
    const left = createSpendStoreFromEnv({});
    const right = createSpendStoreFromEnv({});
    assert.equal(await left.addDailyMicros(DAY, 35_000), 35_000);
    assert.equal(await right.readDailyMicros(DAY), 0);
    for (let i = 0; i < 5; i += 1) await left.recordPlan("203.0.113.4", T0);
    assert.equal(await left.recordPlan("203.0.113.4", T0), 6);
    assert.equal(await right.recordPlan("203.0.113.4", T0), 1);
  });

  it("uses the Redis connector only when both Upstash keys are set", async () => {
    let seen: { readonly url: string; readonly token: string } | null = null;
    const redis = createMemorySpendRedis();
    const connected = createSpendStoreFromEnv(
      { UPSTASH_REDIS_REST_URL: "https://example.upstash.io", UPSTASH_REDIS_REST_TOKEN: "secret" },
      (url, token) => {
        seen = { url, token };
        return redis;
      },
    );
    assert.deepEqual(seen, { url: "https://example.upstash.io", token: "secret" });
    assert.equal(await connected.addDailyMicros(DAY, 35_000), 35_000);

    let called = false;
    const skipped = createSpendStoreFromEnv(
      { UPSTASH_REDIS_REST_URL: "https://example.upstash.io", UPSTASH_REDIS_REST_TOKEN: " " },
      () => {
        called = true;
        return createMemorySpendRedis();
      },
    );
    assert.equal(called, false);
    assert.equal(await skipped.readDailyMicros(DAY), 0);
  });

  it("keeps a non-https Upstash URL in memory so next build can collect /api/plan", async () => {
    let called = false;
    const store = createSpendStoreFromEnv(
      { UPSTASH_REDIS_REST_URL: "redis://bad", UPSTASH_REDIS_REST_TOKEN: "tok" },
      () => {
        called = true;
        return createMemorySpendRedis();
      },
    );
    assert.equal(called, false);
    assert.equal(await store.addDailyMicros(DAY, 1), 1);
  });

  it("checks the memory cap in under 50ms at p95", async () => {
    const store = createSpendStore(createMemorySpendRedis());
    const samples: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const started = performance.now();
      await store.readDailyMicros(DAY);
      await store.recordPlan(`198.51.100.${i % 20}`, T0 + i);
      samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
    assert.equal(p95 < 50, true);
  });
});
