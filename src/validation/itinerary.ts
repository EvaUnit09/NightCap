import { z } from "zod";

import {
  MAX_TRAVEL_LEGS_PER_REQUEST_DEFAULT,
  STOPS_MAX,
  STOPS_MIN,
  STOPS_MIN_SINGLE,
} from "./bounds";
import { oneLineSchema } from "./common";
import { stopSchema } from "./stop";

export {
  MAX_TRAVEL_LEGS_PER_REQUEST_DEFAULT,
  STOPS_MAX,
  STOPS_MIN,
  STOPS_MIN_SINGLE,
} from "./bounds";

export const ITINERARY_OPTIONS_MIN = 2;
export const ITINERARY_OPTIONS_MAX = 3;

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

function itineraryOptionSchemaWithBounds(minStops: number, maxStops: number) {
  return z
    .object({
      theme: oneLineSchema(80),
      stops: z.array(stopSchema).min(minStops).max(maxStops),
    })
    .strict()
    .superRefine(optionTimingRefine);
}

/**
 * One themed option. Default (`false`): 2–4 timed stops.
 * When `singleStop` is true: exactly 1 stop.
 * Only the last stop may omit travel to a next stop.
 */
export function itineraryOptionSchemaFor(singleStop: boolean) {
  return singleStop
    ? itineraryOptionSchemaWithBounds(STOPS_MIN_SINGLE, STOPS_MIN_SINGLE)
    : itineraryOptionSchemaWithBounds(STOPS_MIN, STOPS_MAX);
}

/**
 * One themed option: 2–4 timed stops in chronological order.
 * Only the last stop may omit travel to a next stop.
 */
export const itineraryOptionSchema = itineraryOptionSchemaFor(false);

/**
 * A planned night: 2–3 themed options.
 * No Place ID may appear more than once.
 * A 1-stop option is allowed only when `singleStop` is true.
 * Travel legs (stops − 1 per option; 0 when single-stop) sum to at most `maxLegs`.
 */
export function itinerarySchemaFor(
  options: { maxLegs?: number } = {},
) {
  const maxLegs = options.maxLegs ?? MAX_TRAVEL_LEGS_PER_REQUEST_DEFAULT;
  return z
    .object({
      singleStop: z.boolean().default(false),
      options: z
        .array(itineraryOptionSchemaWithBounds(STOPS_MIN_SINGLE, STOPS_MAX))
        .min(ITINERARY_OPTIONS_MIN)
        .max(ITINERARY_OPTIONS_MAX),
    })
    .strict()
    .superRefine((itinerary, ctx) => {
      itinerary.options.forEach((option, optionIndex) => {
        const allowed = itinerary.singleStop
          ? option.stops.length === STOPS_MIN_SINGLE
          : option.stops.length >= STOPS_MIN && option.stops.length <= STOPS_MAX;
        if (!allowed) {
          ctx.addIssue({
            code: "custom",
            message: itinerary.singleStop
              ? "Each option needs exactly 1 stop when singleStop is true"
              : "Each option needs 2–4 stops unless singleStop is true",
            path: ["options", optionIndex, "stops"],
          });
        }
      });

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

      const legs = itinerary.options.reduce(
        (sum, option) => sum + Math.max(0, option.stops.length - 1),
        0,
      );
      if (legs > maxLegs) {
        ctx.addIssue({
          code: "custom",
          message: `At most ${maxLegs} travel legs per request across all options`,
          path: ["options"],
        });
      }
    });
}

export const itinerarySchema = itinerarySchemaFor();

export type ItineraryOption = z.infer<typeof itineraryOptionSchema>;
export type Itinerary = z.infer<typeof itinerarySchema>;
