/**
 * Stop-count bounds the validator and itinerary schemas enforce.
 * `src/contracts/itinerary.ts` re-exports these so #7 can import either path.
 * Validation does not import config; callers pass `maxLegs` into `itinerarySchemaFor`.
 */
export const STOPS_MIN = 2;
export const STOPS_MIN_SINGLE = 1;
export const STOPS_MAX = 4;

/** Default cap on travel legs per request, summed across options (stops − 1 each). */
export const MAX_TRAVEL_LEGS_PER_REQUEST_DEFAULT = 4;
