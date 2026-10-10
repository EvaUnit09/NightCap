import { z } from "zod";

import { placeIdSchema } from "./common";

/**
 * Failure codes the deterministic checker reports.
 * Format problems on the itinerary/intent boundary are `invalid_format`.
 * `invented_venue` is an unknown Place ID. `not_found` remains for
 * candidate-lookup gaps that are not an invented id.
 */
export const validationErrorCodeSchema = z.enum([
  "not_found",
  "not_operational",
  "closed",
  "over_budget",
  "travel_too_long",
  "invented_venue",
  "invalid_format",
  "name_mismatch",
  "implausible_cost",
  "travel_unverified",
  "travel_mismatch",
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
