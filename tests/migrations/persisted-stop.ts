/**
 * Persistence-only stop shape for `itineraries.stops`.
 * Keep the allowed-key list in sync with
 * `public.itineraries_stops_are_place_ids_only` in the init migration.
 * The pipeline Zod `stopSchema` still includes `name` for live/API use;
 * names must be stripped before INSERT. Do not import src/validation here.
 */
export const PERSISTED_STOP_ALLOWED_KEYS = [
  "placeId",
  "start",
  "end",
  "stopType",
  "estimatedCostUsd",
  "why",
  "travelToNext",
] as const;

export const PERSISTED_STOP_FORBIDDEN_KEYS = [
  "name",
  "address",
  "formatted_address",
  "formattedAddress",
  "rating",
  "user_ratings_total",
  "userRatingsTotal",
  "hours",
  "opening_hours",
  "openingHours",
  "current_opening_hours",
  "currentOpeningHours",
  "price",
  "price_level",
  "priceLevel",
  "vicinity",
  "business_status",
  "businessStatus",
  "website",
  "url",
  "photos",
  "reviews",
] as const;

export type PersistedStop = {
  placeId: string;
  start?: string;
  end?: string;
  stopType?: string;
  estimatedCostUsd?: number;
  why?: string;
  travelToNext?: { mode: string; minutes: number } | null;
};
