import { z } from "zod";

import { oneLineSchema } from "./common";
import { stopSchema } from "./stop";

/**
 * One themed option: 2–4 timed stops in chronological order.
 * Only the last stop may omit travel to a next stop.
 */
export const itineraryOptionSchema = z
  .object({
    theme: oneLineSchema(80),
    stops: z.array(stopSchema).min(2).max(4),
  })
  .strict()
  .superRefine((option, ctx) => {
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
  });

/**
 * A planned night: 2–3 themed options.
 * No Place ID may appear more than once.
 */
export const itinerarySchema = z
  .object({
    options: z.array(itineraryOptionSchema).min(2).max(3),
  })
  .strict()
  .superRefine((itinerary, ctx) => {
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
