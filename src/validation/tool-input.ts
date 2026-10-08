import { z } from "zod";

import {
  isBefore,
  isoDateTimeSchema,
  placeIdSchema,
  priceLevelSchema,
  stopTypeSchema,
} from "./common";
import { itinerarySchema } from "./itinerary";

const timeSlotSchema = z
  .object({
    start: isoDateTimeSchema,
    end: isoDateTimeSchema,
  })
  .strict()
  .refine((slot) => isBefore(slot.start, slot.end), {
    message: "Slot start must be before slot end",
    path: ["end"],
  });

const searchVenuesInputSchema = z
  .object({
    tool: z.literal("search_venues"),
    area: z.string().trim().min(1).max(120),
    category: stopTypeSchema,
    priceLevel: priceLevelSchema,
    openAt: isoDateTimeSchema,
  })
  .strict();

const replaceStopInputSchema = z
  .object({
    tool: z.literal("replace_stop"),
    optionIndex: z.int().min(0).max(2),
    stopIndex: z.int().min(0).max(3),
    placeId: placeIdSchema,
  })
  .strict();

const reorderStopsInputSchema = z
  .object({
    tool: z.literal("reorder_stops"),
    optionIndex: z.int().min(0).max(2),
    order: z.array(z.int().min(0).max(3)).min(2).max(4),
    times: z.array(timeSlotSchema).min(2).max(4),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.order.length !== input.times.length) {
      ctx.addIssue({
        code: "custom",
        message: "Order and times must have the same length",
        path: ["times"],
      });
    }
    if (new Set(input.order).size !== input.order.length) {
      ctx.addIssue({
        code: "custom",
        message: "Order must not repeat a stop index",
        path: ["order"],
      });
    }
  });

const validateItineraryInputSchema = z
  .object({
    tool: z.literal("validate_itinerary"),
    itinerary: itinerarySchema,
  })
  .strict();

/** Input to one refinement tool. Each tool name is its own object shape. */
export const toolInputSchema = z.discriminatedUnion("tool", [
  searchVenuesInputSchema,
  replaceStopInputSchema,
  reorderStopsInputSchema,
  validateItineraryInputSchema,
]);

export type ToolInput = z.infer<typeof toolInputSchema>;
