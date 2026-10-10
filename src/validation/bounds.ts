/**
 * Stop-count bounds the validator and itinerary schemas enforce.
 * `src/contracts/itinerary.ts` re-exports these so #7 can import either path.
 */
export const STOPS_MIN = 2;
export const STOPS_MIN_SINGLE = 1;
export const STOPS_MAX = 4;
