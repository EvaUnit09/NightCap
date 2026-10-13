import "server-only";

import { setTimeout as delay } from "node:timers/promises";

import { createQueryableFromEnv } from "../db/postgres";
import { getGooglePlacesApiKey, getPlacesCoordsCacheTtlDays, getPriceRangesByLevel, getRetrievalSettings } from "../models/config";
import { DEFAULT_PARTY_SIZE } from "../validation/defaults";
import type { Intent } from "../validation/intent";
import { coordsTtlDays, type CoordsCache } from "./coords-cache";
import { createPlacesDetailsLookup } from "./place-details";
import { createPlacesClient } from "./places-client";
import { createPlacesCoordsCache } from "./places-coords-cache";
import { queryFromIntent, queryFromSearchVenues, type SearchVenuesInput } from "./query";
import { retrieveVenues, type Retrieval, type RetrievalDeps } from "./retrieve";

function placesApiKey(): string | undefined {
  try {
    return getGooglePlacesApiKey();
  } catch {
    return undefined;
  }
}

function coordsCacheFromEnv(): CoordsCache | undefined {
  const db = createQueryableFromEnv();
  if (!db) return undefined;
  return createPlacesCoordsCache(db, coordsTtlDays(getPlacesCoordsCacheTtlDays()));
}

/**
 * Deps from config. A missing key is not a throw here: each search reports
 * missing_key and becomes a gap, as Routes does. A database URL attaches the
 * places_cache coordinate adapter. Without one, coordinates stay live.
 */
export function createRetrievalDeps(
  overrides: { readonly fetchImpl?: typeof fetch; readonly coordsCache?: CoordsCache } = {},
): RetrievalDeps {
  const { placesTimeoutMs, ...settings } = getRetrievalSettings();
  const coordsCache = "coordsCache" in overrides ? overrides.coordsCache : coordsCacheFromEnv();
  return {
    places: createPlacesClient({ apiKey: placesApiKey(), timeoutMs: placesTimeoutMs, fetchImpl: overrides.fetchImpl }),
    settings,
    sleep: (ms, signal) => delay(ms, undefined, { signal }),
    ...(coordsCache ? { coordsCache } : {}),
  };
}

export function createPlaceDetailsLookupFromEnv(fetchImpl?: typeof fetch) {
  const { placesTimeoutMs } = getRetrievalSettings();
  return createPlacesDetailsLookup({ apiKey: placesApiKey(), timeoutMs: placesTimeoutMs, fetchImpl });
}

/** Pipeline entry (build step 15). */
export function retrieveForIntent(intent: Intent, signal?: AbortSignal, deps = createRetrievalDeps()): Promise<Retrieval> {
  const query = queryFromIntent(intent, { priceRanges: getPriceRangesByLevel(), partySize: DEFAULT_PARTY_SIZE });
  return retrieveVenues(query, deps, signal);
}

/** Agent search_venues entry (build step 29). Same path as the pipeline. */
export function retrieveForTool(
  input: SearchVenuesInput,
  signal?: AbortSignal,
  deps = createRetrievalDeps(),
): Promise<Retrieval> {
  return retrieveVenues(queryFromSearchVenues(input, { minOpenMinutes: deps.settings.minOpenMinutes }), deps, signal);
}
