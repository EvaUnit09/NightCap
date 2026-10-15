import "server-only";

import { createQueryableFromEnv } from "../db/postgres";
import { createPlacesBlocked, hydrateUnlessBlocked, loadStoredItinerary, type HydratedStop, type PlaceDetailsLookup, type StoredItinerary } from "../monitoring/hydrate-plan";
import { createSpendStoreFromEnv, type SpendStore } from "../monitoring/spend-store";
import { createPlaceDetailsLookupFromEnv } from "../retrieval";

const JSON_HEADERS = { "Cache-Control": "no-store" } as const;

export interface ItineraryViewDeps {
  readonly load: (id: string) => Promise<StoredItinerary | null>;
  readonly lookup: PlaceDetailsLookup;
  /** True when another Places call would start past the daily cap. */
  readonly placesBlocked: () => Promise<boolean>;
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
    const view = await hydrateUnlessBlocked(itinerary.stops, deps.lookup, deps.placesBlocked);
    return viewJson(itinerary, view.stops, view.hydrated);
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
    placesBlocked: createPlacesBlocked(store),
  });
}
