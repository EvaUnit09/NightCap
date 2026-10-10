import { z } from "zod";

import { placeIdSchema } from "./common";

/**
 * Failure codes the deterministic checker reports.
 * Format problems on the itinerary/intent boundary are returned as `not_found`
 * (Zod parse failure) rather than thrown. `not_found` is also used when a
 * stop name does not match its candidate. `invented_venue` is the unknown
 * Place ID. Schema contract is otherwise unchanged.
 */
export const validationErrorCodeSchema = z.enum([
  "not_found",
  "not_operational",
  "closed",
  "over_budget",
  "travel_too_long",
  "invented_venue",
]);

/** One validator finding, pointed at an option and stop when it has one. */
export const validationErrorSchema = z
  .object({
    code: validationErrorCodeSchema,
    message: z.string().trim().min(1).max(300),
    optionIndex: z.int().min(0).max(2).optional(),
    stopIndex: z.int().min(0).max(3).optional(),
    placeId: placeIdSchema.optional(),
  })
  .strict();

export type ValidationErrorCode = z.infer<typeof validationErrorCodeSchema>;
export type ValidationError = z.infer<typeof validationErrorSchema>;
