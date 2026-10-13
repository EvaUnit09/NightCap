import "server-only";

import { createQueryableFromEnv } from "../db/postgres";
import { getRateLimitDailySpendUsd } from "../models/config";
import { hydrateItinerary, loadStoredItinerary, type HydratedStop, type PlaceDetailsLookup, type StoredItinerary } from "../monitoring/hydrate-plan";
import { usdToMicros, utcDay } from "../monitoring/spend-cap";
import { createSpendStoreFromEnv, type SpendStore } from "../monitoring/spend-store";
import { createPlaceDetailsLookupFromEnv } from "../retrieval";

const JSON_HEADERS = { "Cache-Control": "no-store" } as const;

export interface ItineraryViewDeps {
  readonly load: (id: string) => Promise<StoredItinerary | null>;
  readonly lookup: PlaceDetailsLookup;
  /** True when another Places call would start past the daily cap. */
  readonly placesBlocked: () => Promise<boolean>;
}

function unnamed(itinerary: StoredItinerary): HydratedStop[] {
  return itinerary.stops.map((stop) => ({
    ...stop,
    name: null,
    formattedAddress: null,
    rating: null,
    priceLevel: null,
  }));
}

function viewJson(itinerary: StoredItinerary, stops: readonly HydratedStop[], hydrated: boolean): Response {
  return Response.json(
    {
      id: itinerary.id,
      requestId: itinerary.requestId,
      optionIndex: itinerary.optionIndex,
      storedStops: itinerary.stops,
      stops,
      hydrated,
    },
    { headers: JSON_HEADERS },
  );
}

export function createItineraryViewHandler(deps: ItineraryViewDeps): (request: Request, id: string) => Promise<Response> {
  return async (_request, id) => {
    const itinerary = await deps.load(id);
    if (!itinerary) {
      return Response.json({ error: "not_found" }, { status: 404, headers: JSON_HEADERS });
    }
    let blocked = true;
    try {
      blocked = await deps.placesBlocked();
    } catch {
      blocked = true;
    }
    if (blocked) return viewJson(itinerary, unnamed(itinerary), false);
    try {
      const view = await hydrateItinerary(itinerary, deps.lookup);
      return viewJson(itinerary, view.stops, true);
    } catch {
      return viewJson(itinerary, unnamed(itinerary), false);
    }
  };
}

export function createProductionItineraryViewHandler(): (request: Request, id: string) => Promise<Response> {
  const db = createQueryableFromEnv();
  if (!db) {
    return async () => Response.json({ error: "persist_unconfigured" }, { status: 503, headers: JSON_HEADERS });
  }
  const store: SpendStore = createSpendStoreFromEnv();
  return createItineraryViewHandler({
    load: (id) => loadStoredItinerary(db, id),
    lookup: createPlaceDetailsLookupFromEnv(),
    placesBlocked: async () => {
      const spent = await store.readDailyMicros(utcDay(Date.now()));
      return spent >= usdToMicros(getRateLimitDailySpendUsd());
    },
  });
}
