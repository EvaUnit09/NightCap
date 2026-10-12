import "server-only";

import {
  getEnableLiveRoutes,
  getGooglePlacesApiKey,
  getMaxTravelLegsPerRequest,
  getPriceRangesByLevel,
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
 * calculator. Production startup requires ENABLE_LIVE_ROUTES and
 * GOOGLE_PLACES_API_KEY (#31); a runtime outage still uses
 * `travel_service_unavailable`.
 */
export async function validateItineraryServer(
  input: ValidatorInput,
  optionOverrides: Partial<ValidatorOptions> = {}
): ReturnType<typeof validateItinerary> {
  const options: ValidatorOptions = {
    travelCapMinutes: getTravelCapMinutes(),
    travelToleranceMinutes: getTravelClaimToleranceMinutes(),
    travelBudgetMs: getTravelBudgetMs(),
    maxLegs: getMaxTravelLegsPerRequest(),
    travelCalculator: getEnableLiveRoutes()
      ? createRoutesTravelCalculator()
      : undefined,
    priceRanges: getPriceRangesByLevel(),
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
