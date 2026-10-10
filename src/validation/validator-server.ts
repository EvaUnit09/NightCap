import "server-only";

import {
  getEnableLiveRoutes,
  getGooglePlacesApiKey,
  getMaxTravelLegsPerRequest,
  getPriceRanges,
  getRoutesApiTimeoutMs,
  getTravelBudgetMs,
  getTravelCapMinutes,
  getTravelClaimToleranceMinutes,
} from "../models/config";
import { RoutesMatrixTravelCalculator } from "./routes-travel";
import type { TravelCalculator } from "./travel";
import {
  validateItinerary,
  type ValidatorInput,
  type ValidatorOptions,
} from "./validator";

/**
 * Server-only wrapper: fills thresholds from config. Live Routes is attached
 * only when ENABLE_LIVE_ROUTES is set; otherwise travel fails closed as
 * `travel_service_unavailable`. Tests and eval pass a fake or recorded
 * calculator. Missing GOOGLE_PLACES_API_KEY is the same code (not a
 * startup requirement).
 */
export async function validateItineraryServer(
  input: ValidatorInput,
  optionOverrides: Partial<ValidatorOptions> = {}
): Promise<ReturnType<typeof validateItinerary>> {
  const ranges = getPriceRanges();
  const options: ValidatorOptions = {
    travelCapMinutes: getTravelCapMinutes(),
    travelToleranceMinutes: getTravelClaimToleranceMinutes(),
    travelBudgetMs: getTravelBudgetMs(),
    maxLegs: getMaxTravelLegsPerRequest(),
    travelCalculator: getEnableLiveRoutes()
      ? createRoutesTravelCalculator()
      : undefined,
    priceRanges: {
      PRICE_LEVEL_FREE: ranges.free,
      PRICE_LEVEL_INEXPENSIVE: ranges.inexpensive,
      PRICE_LEVEL_MODERATE: ranges.moderate,
      PRICE_LEVEL_EXPENSIVE: ranges.expensive,
      PRICE_LEVEL_VERY_EXPENSIVE: ranges.veryExpensive,
    },
    ...optionOverrides,
  };
  return validateItinerary(input, options);
}

export function createRoutesTravelCalculator(
  fetchImpl?: typeof fetch
): TravelCalculator {
  let apiKey: string | undefined;
  try {
    apiKey = getGooglePlacesApiKey();
  } catch {
    apiKey = undefined;
  }
  return new RoutesMatrixTravelCalculator({
    apiKey,
    timeoutMs: getRoutesApiTimeoutMs(),
    maxLegs: getMaxTravelLegsPerRequest(),
    fetchImpl,
  });
}
