import { z } from "zod";

import {
  businessStatusSchema,
  placeIdSchema,
  priceLevelSchema,
  stopTypeSchema,
} from "./common";

/** A clock time in weekly opening hours. Day 0 is Sunday, matching Places. */
const openingPointSchema = z
  .object({
    day: z.int().min(0).max(6),
    hour: z.int().min(0).max(23),
    minute: z.int().min(0).max(59),
  })
  .strict();

/**
 * One weekly open interval from Places.
 * Review text is not part of this contract.
 * 24/7 venues may omit the close time.
 */
const openingPeriodSchema = z
  .object({
    open: openingPointSchema,
    close: openingPointSchema.optional(),
  })
  .strict();

/**
 * A venue returned by Places and passed to the planner.
 * Hours, price, coordinates, rating, review count, and business status.
 */
export const candidateSchema = z
  .object({
    placeId: placeIdSchema,
    name: z.string().trim().min(1).max(200),
    businessStatus: businessStatusSchema,
    priceLevel: priceLevelSchema.nullable(),
    rating: z.number().min(1).max(5).nullable(),
    reviewCount: z.int().nonnegative(),
    location: z
      .object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
      })
      .strict(),
    openingHours: z.array(openingPeriodSchema),
    types: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
    stopType: stopTypeSchema,
  })
  .strict();

export type Candidate = z.infer<typeof candidateSchema>;
