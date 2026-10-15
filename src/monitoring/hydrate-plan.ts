import "server-only";

import { z } from "zod";

import { getRateLimitDailySpendUsd } from "../models/config";
import { PLACE_DETAILS_MICROS, usdToMicros, utcDay } from "./spend-cap";
import type { SpendStore } from "./spend-store";
import type { Queryable } from "./store-request";
import { storedStopSchema, type StoredStop } from "./stored-stop";

export interface StoredItinerary {
  readonly id: string;
  readonly requestId: string;
  readonly optionIndex: number;
  readonly stops: readonly StoredStop[];
  readonly valid: boolean;
  readonly promptVersions: Readonly<Record<string, unknown>>;
  readonly models: Readonly<Record<string, unknown>>;
  readonly costUsd: number | null;
  readonly latencyMs: number | null;
}

export interface PlaceLiveDetails {
  readonly placeId: string;
  readonly name: string;
  readonly formattedAddress: string | null;
  readonly rating: number | null;
  readonly priceLevel: string | null;
}

export interface PlaceDetailsLookup {
  lookup(placeIds: readonly string[]): Promise<ReadonlyMap<string, PlaceLiveDetails>>;
}

export interface HydratedStop extends StoredStop {
  readonly name: string | null;
  readonly formattedAddress: string | null;
  readonly rating: number | null;
  readonly priceLevel: string | null;
}

const rowSchema = z.object({
  id: z.string().uuid(),
  request_id: z.string().uuid(),
  option_index: z.number().int(),
  stops: z.array(storedStopSchema),
  valid: z.boolean(),
  prompt_versions: z.record(z.string(), z.unknown()),
  models: z.record(z.string(), z.unknown()),
  cost_usd: z.union([z.number(), z.string(), z.null()]),
  latency_ms: z.union([z.number().int(), z.null()]),
});

const SELECT_ITINERARY = `
SELECT id, request_id, option_index, stops, valid, prompt_versions, models, cost_usd, latency_ms
FROM public.itineraries
WHERE id = $1
`;

function finiteOrNull(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function loadStoredItinerary(db: Queryable, id: string): Promise<StoredItinerary | null> {
  const selected = await db.query<unknown>(SELECT_ITINERARY, [id]);
  const row = selected.rows[0];
  if (!row) return null;
  const parsed = rowSchema.parse(row);
  return {
    id: parsed.id,
    requestId: parsed.request_id,
    optionIndex: parsed.option_index,
    stops: parsed.stops,
    valid: parsed.valid,
    promptVersions: parsed.prompt_versions,
    models: parsed.models,
    costUsd: finiteOrNull(parsed.cost_usd),
    latencyMs: parsed.latency_ms,
  };
}

/** Names and Places details come from `lookup`. The stored stops stay placeId-only. */
export async function hydrateStoredStops(
  stops: readonly StoredStop[],
  lookup: PlaceDetailsLookup,
): Promise<readonly HydratedStop[]> {
  const details = await lookup.lookup(stops.map((stop) => stop.placeId));
  return stops.map((stop): HydratedStop => {
    const live = details.get(stop.placeId);
    return {
      ...stop,
      name: live?.name ?? null,
      formattedAddress: live?.formattedAddress ?? null,
      rating: live?.rating ?? null,
      priceLevel: live?.priceLevel ?? null,
    };
  });
}

export async function hydrateItinerary(
  itinerary: StoredItinerary,
  lookup: PlaceDetailsLookup,
): Promise<{ readonly itinerary: StoredItinerary; readonly stops: readonly HydratedStop[] }> {
  return { itinerary, stops: await hydrateStoredStops(itinerary.stops, lookup) };
}

function withoutDetails(stops: readonly StoredStop[]): HydratedStop[] {
  return stops.map((stop) => ({ ...stop, name: null, formattedAddress: null, rating: null, priceLevel: null }));
}

/** Falls back to bare stops when the cap check or the lookup fails, or the cap is reached. */
export async function hydrateUnlessBlocked(
  stops: readonly StoredStop[],
  lookup: PlaceDetailsLookup,
  store: SpendStore,
): Promise<{ readonly stops: readonly HydratedStop[]; readonly hydrated: boolean }> {
  try {
    const day = utcDay(Date.now());
    if ((await store.readDailyMicros(day)) < usdToMicros(getRateLimitDailySpendUsd())) {
      const hydrated = await hydrateStoredStops(stops, lookup);
      const uniqueIds = new Set(stops.map((stop) => stop.placeId)).size;
      await store.addDailyMicros(day, uniqueIds * PLACE_DETAILS_MICROS).catch(() => undefined);
      return { stops: hydrated, hydrated: true };
    }
  } catch {
    // fall through to bare stops
  }
  return { stops: withoutDetails(stops), hydrated: false };
}
