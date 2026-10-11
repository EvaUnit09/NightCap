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

/** NightCap v1 travel modes. Same strings Google Routes uses; #7's mapping is identity. */
export const TRAVEL_MODES = ["TRANSIT", "BICYCLE", "WALK"] as const;
export type TravelMode = (typeof TRAVEL_MODES)[number];
export const travelModeSchema = z.enum(TRAVEL_MODES);

/** Model-output boundary only: trim + uppercase. Dropped modes are not mapped. */
export function normalizeModelTravelMode(mode: string): string {
  return mode.trim().toUpperCase();
}

const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function entriesWithoutForbidden(
  record: Record<string, unknown>,
  mapValue: (key: string, child: unknown) => unknown,
): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  for (const [key, child] of Object.entries(record)) {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      continue;
    }
    entries.push([key, mapValue(key, child)]);
  }
  return entries;
}

export function normalizeModelTravelModes(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeModelTravelModes);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    entriesWithoutForbidden(record, (key, child) => {
      if (key === "mode" && typeof child === "string") {
        return normalizeModelTravelMode(child);
      }
      return normalizeModelTravelModes(child);
    }),
  );
}

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
