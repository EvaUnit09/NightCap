/**
 * One origin → destination hop the validator asks a calculator to time.
 * `from` or `to` is null when that side has no coordinates (invented stop).
 */
export interface TravelLeg {
  from: { lat: number; lng: number } | null;
  to: { lat: number; lng: number } | null;
  mode: "walk" | "transit" | "rideshare";
}

/**
 * Travel-minutes calculator.
 *
 * Production uses `RoutesMatrixTravelCalculator` (server-only).
 * `HaversineEstimator` is a test / offline fallback only — not the default.
 *
 * `calculateMinutes` may return a Promise or a sync array. The validator awaits
 * either. Return `null` for a leg that cannot be computed; the validator fails closed.
 */
export interface TravelCalculator {
  calculateMinutes(
    legs: readonly TravelLeg[]
  ): Promise<ReadonlyArray<number | null>> | ReadonlyArray<number | null>;
}

export interface HaversineOptions {
  /** Manhattan walking circuity. Boeing 2019. Default 1.14. */
  walkCircuity?: number;
  /** Manhattan driving circuity. Boeing 2019. Default 1.21. */
  driveCircuity?: number;
  /** Walking speed in mph. Default 3.0. */
  walkSpeedMph?: number;
  /**
   * Door-to-door transit speed in mph (walk access + wait + in-vehicle).
   * Default 8.0 so a ~2–3 mi borough hop lands around 20–30 min.
   */
  transitSpeedMph?: number;
  /** Manhattan CBD average speed, mph. NYC IBO 2025. Default 7.1. */
  rideshareSpeedMph?: number;
}

/**
 * Offline / test fallback. Not the production default.
 *
 * Straight-line Haversine × circuity ÷ modal speed, ceiled to whole minutes.
 */
export class HaversineEstimator implements TravelCalculator {
  private readonly earthRadiusMi = 3958.8;
  private readonly walkCircuity: number;
  private readonly driveCircuity: number;
  private readonly walkSpeedMph: number;
  private readonly transitSpeedMph: number;
  private readonly rideshareSpeedMph: number;

  constructor(options: HaversineOptions = {}) {
    this.walkCircuity = options.walkCircuity ?? 1.14;
    this.driveCircuity = options.driveCircuity ?? 1.21;
    this.walkSpeedMph = options.walkSpeedMph ?? 3.0;
    this.transitSpeedMph = options.transitSpeedMph ?? 8.0;
    this.rideshareSpeedMph = options.rideshareSpeedMph ?? 7.1;
  }

  calculateMinutes(legs: readonly TravelLeg[]): Array<number | null> {
    return legs.map((leg) => this.oneLeg(leg));
  }

  private oneLeg(leg: TravelLeg): number | null {
    if (!leg.from || !leg.to) {
      return null;
    }
    const speedMph = this.speedFor(leg.mode);
    const circuity = this.circuityFor(leg.mode);
    if (speedMph === null || circuity === null) {
      return null;
    }
    const routeMi = this.haversineDistance(leg.from, leg.to) * circuity;
    return Math.ceil((routeMi / speedMph) * 60);
  }

  private speedFor(mode: TravelLeg["mode"]): number | null {
    switch (mode) {
      case "walk":
        return this.walkSpeedMph;
      case "transit":
        return this.transitSpeedMph;
      case "rideshare":
        return this.rideshareSpeedMph;
      default:
        return null;
    }
  }

  private circuityFor(mode: TravelLeg["mode"]): number | null {
    switch (mode) {
      case "walk":
      case "transit":
        return this.walkCircuity;
      case "rideshare":
        return this.driveCircuity;
      default:
        return null;
    }
  }

  private haversineDistance(
    from: { lat: number; lng: number },
    to: { lat: number; lng: number }
  ): number {
    const lat1 = this.toRadians(from.lat);
    const lat2 = this.toRadians(to.lat);
    const dLat = this.toRadians(to.lat - from.lat);
    const dLng = this.toRadians(to.lng - from.lng);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return this.earthRadiusMi * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private toRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  }
}

/** Test / offline fallback instance. Do not use as the production default. */
export const haversineFallbackCalculator: TravelCalculator =
  new HaversineEstimator();
