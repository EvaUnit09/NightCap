import "server-only";

import { z } from "zod";

import { isoDateTimeSchema, placeIdSchema } from "../validation/common";
import { travelToNextSchema, type TravelToNext } from "../validation/stop";

/** Keys `itineraries_stops_are_place_ids_only` allows. `name` is not one of them. */
export const STORED_STOP_KEYS = [
  "placeId",
  "start",
  "end",
  "stopType",
  "estimatedCostUsd",
  "why",
  "travelToNext",
] as const;

const storedStopKey = new Set<string>(STORED_STOP_KEYS);

export const storedStopSchema = z
  .object({
    placeId: placeIdSchema,
    start: isoDateTimeSchema,
    end: isoDateTimeSchema,
    stopType: z.string().trim().min(1).max(40).optional(),
    estimatedCostUsd: z.number().int().nonnegative(),
    why: z.string().trim().min(1).max(200),
    travelToNext: travelToNextSchema.nullable(),
  })
  .strict();

export type StoredStop = z.infer<typeof storedStopSchema>;

export function stripStopForStorage(stop: {
  readonly placeId: string;
  readonly start: string;
  readonly end: string;
  readonly estimatedCostUsd: number;
  readonly why: string;
  readonly travelToNext: TravelToNext | null;
}): StoredStop {
  return storedStopSchema.parse({
    placeId: stop.placeId,
    start: stop.start,
    end: stop.end,
    estimatedCostUsd: stop.estimatedCostUsd,
    why: stop.why,
    travelToNext: stop.travelToNext,
  });
}

export function assertStoredStops(stops: readonly StoredStop[]): void {
  for (const stop of stops) {
    for (const key of Object.keys(stop)) {
      if (!storedStopKey.has(key)) {
        throw new Error(`itinerary stop key ${key} is not stored`);
      }
    }
  }
}
