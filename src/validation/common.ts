import { z } from "zod";

/** ISO-8601 datetime with a `Z` or numeric offset, so a New York slot keeps its zone. */
export const isoDateTimeSchema = z.iso.datetime({ offset: true });

/** Google Place ID. Venues are referenced only by this id. */
export const placeIdSchema = z.string().trim().min(1).max(300);

/** Stop kinds the parser can request and retrieval can search. */
export const stopTypeSchema = z.enum([
  "drinks",
  "dinner",
  "dessert",
  "bar",
  "activity",
]);

/** Google Places price level. Absent levels stay null on a candidate. */
export const priceLevelSchema = z.enum([
  "PRICE_LEVEL_UNSPECIFIED",
  "PRICE_LEVEL_FREE",
  "PRICE_LEVEL_INEXPENSIVE",
  "PRICE_LEVEL_MODERATE",
  "PRICE_LEVEL_EXPENSIVE",
  "PRICE_LEVEL_VERY_EXPENSIVE",
]);

/** How the party gets to the next stop. The duration cap is a later check. */
export const travelModeSchema = z.enum(["walk", "transit", "rideshare"]);

/** Places `business_status` values. */
export const businessStatusSchema = z.enum([
  "OPERATIONAL",
  "CLOSED_TEMPORARILY",
  "CLOSED_PERMANENTLY",
  "FUTURE_OPENING",
]);

/**
 * A single line of model copy.
 * @param max - Maximum characters after trim.
 */
export function oneLineSchema(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !value.includes("\n"), {
      message: "Must be a single line",
    });
}

/** True when `start` is strictly before `end`. Both values are already ISO datetimes. */
export function isBefore(start: string, end: string): boolean {
  return Date.parse(start) < Date.parse(end);
}
