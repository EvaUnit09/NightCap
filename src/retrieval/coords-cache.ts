export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

/** A places_cache row with coords present. */
export interface CoordsEntry {
  readonly placeId: string;
  readonly coords: LatLng;
  readonly fetchedAt: Date;
  readonly expiresAt: Date;
}

export interface CoordsObservation {
  readonly placeId: string;
  readonly coords: LatLng;
}

/** Google terms: lat/lng may be kept at most 30 consecutive days. */
export const COORDS_TTL_DAYS_MAX = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type CoordsTtlDays = number & { readonly __brand: "CoordsTtlDays" };

export function coordsTtlDays(days: number): CoordsTtlDays {
  if (!Number.isInteger(days) || days < 1 || days > COORDS_TTL_DAYS_MAX) {
    throw new RangeError(
      `Coords TTL must be an integer from 1 to ${COORDS_TTL_DAYS_MAX} days (got ${days})`,
    );
  }
  return days as CoordsTtlDays;
}

/** Expired entries are never served. */
export function isLive(entry: CoordsEntry, now: Date): boolean {
  return now.getTime() < entry.expiresAt.getTime();
}

/**
 * What to do with one observation. "keep" makes a repeat a no-op, so the
 * plan is idempotent. The places_cache guard trigger rejects changing
 * coords_fetched_at while lat/lng stay equal, so a live row is never
 * refreshed in place; how a "replace" reaches the row is the adapter's call.
 */
export type CoordsWrite =
  | { readonly kind: "keep" }
  | { readonly kind: "insert" | "replace"; readonly entry: CoordsEntry };

export function planCoordsWrite(
  existing: CoordsEntry | undefined,
  observed: CoordsObservation,
  now: Date,
  ttl: CoordsTtlDays,
): CoordsWrite {
  const entry: CoordsEntry = {
    placeId: observed.placeId,
    coords: observed.coords,
    fetchedAt: now,
    expiresAt: new Date(now.getTime() + ttl * MS_PER_DAY),
  };
  if (existing === undefined) {
    return { kind: "insert", entry };
  }
  if (isLive(existing, now) && sameCoords(existing.coords, observed.coords)) {
    return { kind: "keep" };
  }
  return { kind: "replace", entry };
}

function sameCoords(left: LatLng, right: LatLng): boolean {
  return left.lat === right.lat && left.lng === right.lng;
}

/**
 * Port for places_cache coords. The Supabase adapter waits for the first DB
 * client (build step 24); place_id rows live indefinitely, only coords expire.
 */
export interface CoordsCache {
  /** Live coords only. Missing or expired ids are absent from the map. */
  read(placeIds: readonly string[], now: Date): Promise<ReadonlyMap<string, LatLng>>;
  record(observations: readonly CoordsObservation[], now: Date): Promise<void>;
}

/**
 * Per-process adapter. Concurrent records of one placeId both carry fresh
 * Google coords, and a repeat plans to "keep", so no lock is needed.
 */
export function createMemoryCoordsCache(ttl: CoordsTtlDays): CoordsCache {
  let entries: ReadonlyMap<string, CoordsEntry> = new Map();
  return {
    async read(placeIds, now) {
      const live = placeIds.flatMap((placeId) => {
        const entry = entries.get(placeId);
        return entry && isLive(entry, now) ? [[placeId, entry.coords] as const] : [];
      });
      return new Map(live);
    },
    async record(observations, now) {
      entries = observations.reduce((current, observed) => {
        const write = planCoordsWrite(current.get(observed.placeId), observed, now, ttl);
        return write.kind === "keep"
          ? current
          : new Map([...current, [observed.placeId, write.entry]]);
      }, entries);
    },
  };
}
