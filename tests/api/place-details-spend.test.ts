import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { createItineraryViewHandler } from "../../src/api/itinerary-view";
import { createSharedPlanHandler } from "../../src/api/share";
import { resetConfig } from "../../src/models";
import { getRateLimitDailySpendUsd } from "../../src/models/config";
import type { PlaceDetailsLookup, StoredItinerary } from "../../src/monitoring/hydrate-plan";
import { PLACE_DETAILS_MICROS, usdToMicros, utcDay } from "../../src/monitoring/spend-cap";
import { createMemorySpendRedis, createSpendStore, type SpendStore } from "../../src/monitoring/spend-store";

const ID = "44444444-4444-4444-8444-444444444444";
const SLUG = "abcdefghijklmnopqrstu";
const PLACE_IDS = ["ChIJaaa0", "ChIJbbb0", "ChIJaaa0"];

const stops = PLACE_IDS.map((placeId, index) => ({
  placeId,
  start: `2026-10-17T0${index + 1}:00:00.000Z`,
  end: `2026-10-17T0${index + 1}:45:00.000Z`,
  estimatedCostUsd: 20,
  why: "good",
  travelToNext: null,
}));

const itinerary: StoredItinerary = {
  id: ID,
  requestId: ID,
  optionIndex: 0,
  stops,
  valid: true,
  promptVersions: {},
  models: {},
  costUsd: null,
  latencyMs: null,
};

const lookup: PlaceDetailsLookup = {
  async lookup(placeIds) {
    return new Map(
      placeIds.map((placeId) => [
        placeId,
        { placeId, name: `Live ${placeId}`, formattedAddress: null, rating: null, priceLevel: null },
      ]),
    );
  },
};

const sharedDb = {
  async query<T>() {
    return { rows: [{ itinerary_id: ID, option_index: 0, stops, valid: true }] as T[] };
  },
};

function today(): string {
  return utcDay(Date.now());
}

function capMicros(): number {
  return usdToMicros(getRateLimitDailySpendUsd());
}

const surfaces: readonly {
  readonly name: string;
  readonly view: (store: SpendStore) => Promise<{ hydrated: boolean }>;
}[] = [
  {
    name: "itinerary view",
    view: async (store) => {
      const handler = createItineraryViewHandler({ load: async () => itinerary, lookup, store });
      return (await handler(new Request("http://localhost/"), ID)).json();
    },
  },
  {
    name: "share reader",
    view: async (store) => {
      const handler = createSharedPlanHandler({ db: sharedDb, lookup, store });
      return (await handler(SLUG)).json();
    },
  },
];

describe("Place Details spend", () => {
  beforeEach(() => resetConfig());

  for (const surface of surfaces) {
    it(`${surface.name} adds one Place Details charge per unique placeId`, async () => {
      const store = createSpendStore(createMemorySpendRedis());
      const body = await surface.view(store);
      assert.equal(body.hydrated, true);
      assert.equal(await store.readDailyMicros(today()), 2 * PLACE_DETAILS_MICROS);
    });

    it(`${surface.name} charges nothing when the cap blocks the lookup`, async () => {
      const store = createSpendStore(createMemorySpendRedis());
      await store.addDailyMicros(today(), capMicros());
      const body = await surface.view(store);
      assert.equal(body.hydrated, false);
      assert.equal(await store.readDailyMicros(today()), capMicros());
    });

    it(`${surface.name} hydrates once at cap minus 1 micro, then blocks`, async () => {
      const store = createSpendStore(createMemorySpendRedis());
      await store.addDailyMicros(today(), capMicros() - 1);
      assert.equal((await surface.view(store)).hydrated, true);
      assert.equal((await surface.view(store)).hydrated, false);
    });

    it(`${surface.name} still serves the view when the ledger write fails`, async () => {
      const base = createSpendStore(createMemorySpendRedis());
      const store: SpendStore = {
        ...base,
        addDailyMicros: async () => {
          throw new Error("ledger down");
        },
      };
      assert.equal((await surface.view(store)).hydrated, true);
    });
  }
});
