import {
  isLive,
  planCoordsWrite,
  type CoordsCache,
  type CoordsEntry,
  type CoordsTtlDays,
  type LatLng,
} from "./coords-cache";
import { inTransaction } from "../db/transaction";
import type { Queryable } from "../monitoring/store-request";

interface CacheRow {
  place_id: string;
  lat: string | number | null;
  lng: string | number | null;
  coords_fetched_at: Date | string | null;
  coords_expires_at: Date | string | null;
}

function asDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("places_cache timestamp is not a date");
  return date;
}

function asCoord(value: string | number): number {
  const coord = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(coord)) throw new Error("places_cache coordinate is not a number");
  return coord;
}

function entryFromRow(row: CacheRow): CoordsEntry | undefined {
  if (row.lat === null || row.lng === null || row.coords_fetched_at === null || row.coords_expires_at === null) {
    return undefined;
  }
  return {
    placeId: row.place_id,
    coords: { lat: asCoord(row.lat), lng: asCoord(row.lng) },
    fetchedAt: asDate(row.coords_fetched_at),
    expiresAt: asDate(row.coords_expires_at),
  };
}

async function readRows(db: Queryable, placeIds: readonly string[]): Promise<Map<string, CoordsEntry>> {
  if (placeIds.length === 0) return new Map();
  const selected = await db.query<CacheRow>(
    `SELECT place_id, lat, lng, coords_fetched_at, coords_expires_at
     FROM public.places_cache
     WHERE place_id = ANY($1::text[])`,
    [placeIds],
  );
  const entries = new Map<string, CoordsEntry>();
  for (const row of selected.rows) {
    const entry = entryFromRow(row);
    if (entry) entries.set(entry.placeId, entry);
  }
  return entries;
}

/**
 * The guard trigger rejects an UPDATE that changes coords_fetched_at while
 * lat/lng stay equal, so an expired refresh with the same coordinates is a
 * delete plus insert.
 */
async function writeEntry(db: Queryable, existing: CoordsEntry | undefined, entry: CoordsEntry): Promise<void> {
  const same =
    existing !== undefined && existing.coords.lat === entry.coords.lat && existing.coords.lng === entry.coords.lng;
  if (existing !== undefined && same) {
    await db.query(`DELETE FROM public.places_cache WHERE place_id = $1`, [entry.placeId]);
  }
  if (existing === undefined || same) {
    await db.query(
      `INSERT INTO public.places_cache (place_id, lat, lng, coords_fetched_at, coords_expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [entry.placeId, entry.coords.lat, entry.coords.lng, entry.fetchedAt.toISOString(), entry.expiresAt.toISOString()],
    );
    return;
  }
  await db.query(
    `UPDATE public.places_cache
     SET lat = $2, lng = $3, coords_fetched_at = $4, coords_expires_at = $5
     WHERE place_id = $1`,
    [entry.placeId, entry.coords.lat, entry.coords.lng, entry.fetchedAt.toISOString(), entry.expiresAt.toISOString()],
  );
}

export function createPlacesCoordsCache(db: Queryable, ttl: CoordsTtlDays): CoordsCache {
  return {
    async read(placeIds, now) {
      const entries = await readRows(db, placeIds);
      const live = new Map<string, LatLng>();
      for (const placeId of placeIds) {
        const entry = entries.get(placeId);
        if (entry && isLive(entry, now)) live.set(placeId, entry.coords);
      }
      return live;
    },
    async record(observations, now) {
      if (observations.length === 0) return;
      await inTransaction(db, async (tx) => {
        const existing = await readRows(tx, observations.map((observed) => observed.placeId));
        for (const observed of observations) {
          const write = planCoordsWrite(existing.get(observed.placeId), observed, now, ttl);
          if (write.kind === "keep") continue;
          await writeEntry(tx, write.kind === "insert" ? undefined : existing.get(observed.placeId), write.entry);
          existing.set(observed.placeId, write.entry);
        }
      });
    },
  };
}
