import { z } from "zod";

import {
  isBefore,
  isoDateTimeSchema,
  oneLineSchema,
  placeIdSchema,
  travelModeSchema,
} from "./common";

/** Minutes and mode from this stop to the next. Null on the last stop. */
export const travelToNextSchema = z
  .object({
    mode: travelModeSchema,
    minutes: z.int().nonnegative().max(24 * 60),
  })
  .strict();

/**
 * One timed stop.
 * Place id, name, start and end, estimated cost, a one-line why,
 * and travel to the next stop when this stop is not last.
 */
export const stopSchema = z
  .object({
    placeId: placeIdSchema,
    name: z.string().trim().min(1).max(200),
    start: isoDateTimeSchema,
    end: isoDateTimeSchema,
    estimatedCostUsd: z.int().nonnegative().max(100_000),
    why: oneLineSchema(200),
    travelToNext: travelToNextSchema.nullable(),
  })
  .strict()
  .refine((stop) => isBefore(stop.start, stop.end), {
    message: "Stop start must be before stop end",
    path: ["end"],
  });

export type Stop = z.infer<typeof stopSchema>;
export type TravelToNext = z.infer<typeof travelToNextSchema>;
