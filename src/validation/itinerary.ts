import { z } from "zod";

import { oneLineSchema } from "./common";
import { stopSchema } from "./stop";

export const ITINERARY_OPTIONS_MIN = 2;
export const ITINERARY_OPTIONS_MAX = 3;
export const STOPS_MIN = 2;
export const STOPS_MIN_SINGLE = 1;
export const STOPS_MAX = 4;

function optionTimingRefine(
  option: { stops: Array<{ start: string; end: string; travelToNext: unknown }> },
  ctx: z.RefinementCtx
): void {
  option.stops.forEach((stop, index) => {
    const isLast = index === option.stops.length - 1;
    if (isLast && stop.travelToNext !== null) {
      ctx.addIssue({
        code: "custom",
        message: "The last stop has no travel to a next stop",
        path: ["stops", index, "travelToNext"],
      });
    }
    if (!isLast && stop.travelToNext === null) {
      ctx.addIssue({
        code: "custom",
        message: "Every stop except the last needs travel to the next stop",
        path: ["stops", index, "travelToNext"],
      });
    }
    const previous = option.stops[index - 1];
    if (previous && Date.parse(stop.start) < Date.parse(previous.end)) {
      ctx.addIssue({
        code: "custom",
        message: "Stops must be in chronological order",
        path: ["stops", index, "start"],
      });
    }
  });
}

function itineraryOptionSchemaWithMinStops(minStops: number) {
  return z
    .object({
      theme: oneLineSchema(80),
      stops: z.array(stopSchema).min(minStops).max(STOPS_MAX),
    })
    .strict()
    .superRefine(optionTimingRefine);
}

/**
 * One themed option: 2–4 timed stops in chronological order.
 * Only the last stop may omit travel to a next stop.
 */
export const itineraryOptionSchema = itineraryOptionSchemaWithMinStops(STOPS_MIN);

/**
 * A planned night: 2–3 themed options.
 * No Place ID may appear more than once.
 * A 1-stop option is allowed only when `singleStop` is true.
 */
export const itinerarySchema = z
  .object({
    singleStop: z.boolean().default(false),
    options: z
      .array(itineraryOptionSchemaWithMinStops(STOPS_MIN_SINGLE))
      .min(ITINERARY_OPTIONS_MIN)
      .max(ITINERARY_OPTIONS_MAX),
  })
  .strict()
  .superRefine((itinerary, ctx) => {
    if (!itinerary.singleStop) {
      itinerary.options.forEach((option, optionIndex) => {
        if (option.stops.length < STOPS_MIN) {
          ctx.addIssue({
            code: "custom",
            message: "Each option needs 2–4 stops unless singleStop is true",
            path: ["options", optionIndex, "stops"],
          });
        }
      });
    }

    const seen = new Set<string>();
    itinerary.options.forEach((option, optionIndex) => {
      option.stops.forEach((stop, stopIndex) => {
        if (seen.has(stop.placeId)) {
          ctx.addIssue({
            code: "custom",
            message: "A venue cannot be shared between options",
            path: ["options", optionIndex, "stops", stopIndex, "placeId"],
          });
          return;
        }
        seen.add(stop.placeId);
      });
    });
  });

export type ItineraryOption = z.infer<typeof itineraryOptionSchema>;
export type Itinerary = z.infer<typeof itinerarySchema>;
