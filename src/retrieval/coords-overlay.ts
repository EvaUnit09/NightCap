import type { Candidate } from "../validation/candidate";
import type { CoordsCache } from "./coords-cache";
import type { RankedByStopType } from "./rank";

/**
 * Reads cached coords for the ranked candidates and records the live
 * coordinates of those the cache could not serve (missing or expired). A live
 * cached value replaces the candidate's location; everything else on the
 * candidate (name, hours, price, rating) stays as Text Search returned it.
 * The cache is an optimisation, so a failing port degrades to live coords
 * instead of failing retrieval. A parent abort is not a cache failure.
 */
export async function overlayCachedCoords(
  ranked: RankedByStopType,
  cache: CoordsCache,
  now: Date,
  signal?: AbortSignal,
): Promise<RankedByStopType> {
  const candidates = [...ranked.values()].flat();
  const liveById = new Map(candidates.map((c) => [c.placeId, c.location] as const));
  if (liveById.size === 0) return ranked;
  try {
    const cached = await cache.read([...liveById.keys()], now);
    const misses = [...liveById].filter(([placeId]) => !cached.has(placeId));
    await cache.record(
      misses.map(([placeId, coords]) => ({ placeId, coords })),
      now,
    );
    return new Map(
      [...ranked].map(([stopType, list]) => [
        stopType,
        list.map((c): Candidate => ({ ...c, location: cached.get(c.placeId) ?? c.location })),
      ]),
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    return ranked;
  }
}
