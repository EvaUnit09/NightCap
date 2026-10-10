import "server-only";

/**
 * Travel time calculator interface.
 * Swap implementations to change how travel minutes are computed.
 */
export interface TravelCalculator {
  /**
   * Compute travel time between two locations.
   * @param from - Origin coordinates
   * @param to - Destination coordinates
   * @param mode - Travel mode (walk, transit, rideshare)
   * @returns Travel time in minutes, or null if calculation fails
   */
  calculateMinutes(
    from: { lat: number; lng: number },
    to: { lat: number; lng: number },
    mode: "walk" | "transit" | "rideshare"
  ): Promise<number | null> | number | null;
}

/**
 * Haversine-based travel time estimator.
 * Pure function, no API calls.
 *
 * Method:
 * - Computes straight-line distance using Haversine formula
 * - Applies detour factor of 1.4 to approximate actual route
 * - Divides by modal speed to get time estimate
 *
 * Speeds (NYC-calibrated):
 * - Walk: 3.0 mph (4.8 km/h)
 * - Transit: 12.0 mph (19.3 km/h) including wait time
 * - Rideshare: 15.0 mph (24.1 km/h) accounting for NYC traffic
 *
 * Accuracy: ±30% typical, best for short distances (<5 mi).
 * Underestimates when actual route requires backtracking.
 * Does not account for time-of-day traffic or subway delays.
 */
export class HaversineEstimator implements TravelCalculator {
  private readonly EARTH_RADIUS_MI = 3958.8;
  private readonly DETOUR_FACTOR = 1.4;
  private readonly SPEEDS_MPH = {
    walk: 3.0,
    transit: 12.0,
    rideshare: 15.0,
  };

  calculateMinutes(
    from: { lat: number; lng: number },
    to: { lat: number; lng: number },
    mode: "walk" | "transit" | "rideshare"
  ): number {
    const straightLineMi = this.haversineDistance(from, to);
    const routeMi = straightLineMi * this.DETOUR_FACTOR;
    const speedMph = this.SPEEDS_MPH[mode];
    const hours = routeMi / speedMph;
    return Math.ceil(hours * 60);
  }

  private haversineDistance(
    from: { lat: number; lng: number },
    to: { lat: number; lng: number }
  ): number {
    const lat1Rad = this.toRadians(from.lat);
    const lat2Rad = this.toRadians(to.lat);
    const deltaLatRad = this.toRadians(to.lat - from.lat);
    const deltaLngRad = this.toRadians(to.lng - from.lng);

    const a =
      Math.sin(deltaLatRad / 2) * Math.sin(deltaLatRad / 2) +
      Math.cos(lat1Rad) *
        Math.cos(lat2Rad) *
        Math.sin(deltaLngRad / 2) *
        Math.sin(deltaLngRad / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return this.EARTH_RADIUS_MI * c;
  }

  private toRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  }
}

/**
 * Default travel calculator.
 * Currently uses Haversine estimator. Swap here to use a different implementation.
 */
export const defaultTravelCalculator: TravelCalculator =
  new HaversineEstimator();
