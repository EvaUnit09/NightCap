import { createMapCoordsHandler } from "../../../src/api/map-coords";
import { createQueryableFromEnv } from "../../../src/db/postgres";
import { getPlacesCoordsCacheTtlDays } from "../../../src/models/config";
import { coordsTtlDays, createPlacesCoordsCache, type CoordsCache } from "../../../src/retrieval";

function cacheFromEnv(): CoordsCache | null {
  const db = createQueryableFromEnv();
  if (!db) return null;
  return createPlacesCoordsCache(db, coordsTtlDays(getPlacesCoordsCacheTtlDays()));
}

const cache = cacheFromEnv();

export const POST = createMapCoordsHandler(async (placeIds, now) => {
  if (!cache) return new Map();
  return cache.read(placeIds, now);
});
