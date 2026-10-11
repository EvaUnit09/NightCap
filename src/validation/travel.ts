import { TRAVEL_MODES, travelModeSchema, type TravelMode } from "./common";

export { TRAVEL_MODES, travelModeSchema, type TravelMode } from "./common";

/**
 * NightCap v1 travel modes from `travelModeSchema` in `./common`:
 * TRANSIT, BICYCLE, WALK. Mapping onto Routes `travelMode` is identity.
 * Any other value fails closed.
 */
export const SUPPORTED_TRAVEL_MODES = TRAVEL_MODES;
export type SupportedTravelMode = TravelMode;

/** Identity: only the exact `travelModeSchema` strings are supported. */
export function normalizeTravelMode(mode: string): TravelMode | null {
  const parsed = travelModeSchema.safeParse(mode);
  return parsed.success ? parsed.data : null;
}

export function isSupportedTravelMode(mode: string): boolean {
  return normalizeTravelMode(mode) !== null;
}

/**
 * One origin → destination hop the validator asks a calculator to time.
 * `from` or `to` is null when that side has no coordinates (invented stop).
 * `mode` is a string so unsupported values can fail closed at runtime.
 */
export interface TravelLeg {
  from: { lat: number; lng: number } | null;
  to: { lat: number; lng: number } | null;
  mode: string;
  /**
   * RFC-3339 departure for TRANSIT. The originating stop's end time.
   * Omitted for WALK and BICYCLE.
   */
  departureTime?: string;
}

/**
 * Thrown when live Routes cannot run: live-off is handled by the validator
 * (no calculator), a missing key, an HTTP/network outage, or an abort.
 * Venue faults (missing coords, ROUTE_NOT_FOUND) stay `null` minutes.
 */
export class TravelServiceUnavailableError extends Error {
  readonly code = "travel_service_unavailable" as const;

  constructor(message = "Travel service is unavailable") {
    super(message);
    this.name = "TravelServiceUnavailableError";
  }
}

/**
 * Travel-minutes calculator.
 *
 * Production uses `RoutesMatrixTravelCalculator` (server-only).
 * `HaversineEstimator` is a test / offline fallback only — not the default.
 *
 * `calculateMinutes` may return a Promise or a sync array. The validator awaits
 * either. Return `null` for a leg that cannot be computed; the validator fails closed.
 * Throw `TravelServiceUnavailableError` (or any error) for a live-Routes outage.
 * When the validator's travel budget expires it aborts `signal`.
 */
export interface TravelCalculator {
  calculateMinutes(
    legs: readonly TravelLeg[],
    signal?: AbortSignal
  ): Promise<ReadonlyArray<number | null>> | ReadonlyArray<number | null>;
}

export interface HaversineOptions {
  /** Manhattan walking circuity. Boeing 2019. Default 1.14. */
  walkCircuity?: number;
  /** Walking speed in mph. Default 3.0. */
  walkSpeedMph?: number;
  /**
   * Door-to-door transit speed in mph (walk access + wait + in-vehicle).
   * Default 8.0 so a ~2–3 mi borough hop lands around 20–30 min.
   */
  transitSpeedMph?: number;
  /** Urban cycling speed in mph. Default 10. */
  bicycleSpeedMph?: number;
}

/**
 * Offline / test fallback. Not the production default.
 *
 * Straight-line Haversine × circuity ÷ modal speed, ceiled to whole minutes.
 */
export class HaversineEstimator implements TravelCalculator {
  private readonly earthRadiusMi = 3958.8;
  private readonly walkCircuity: number;
  private readonly walkSpeedMph: number;
  private readonly transitSpeedMph: number;
  private readonly bicycleSpeedMph: number;

  constructor(options: HaversineOptions = {}) {
    this.walkCircuity = options.walkCircuity ?? 1.14;
    this.walkSpeedMph = options.walkSpeedMph ?? 3.0;
    this.transitSpeedMph = options.transitSpeedMph ?? 8.0;
    this.bicycleSpeedMph = options.bicycleSpeedMph ?? 10.0;
  }

  calculateMinutes(legs: readonly TravelLeg[]): Array<number | null> {
    return legs.map((leg) => this.oneLeg(leg));
  }

  private oneLeg(leg: TravelLeg): number | null {
    if (!leg.from || !leg.to) {
      return null;
    }
    const mode = normalizeTravelMode(leg.mode);
    if (mode === null) {
      return null;
    }
    const speedMph = this.speedFor(mode);
    const circuity = this.circuityFor(mode);
    if (speedMph === null || circuity === null) {
      return null;
    }
    const routeMi = this.haversineDistance(leg.from, leg.to) * circuity;
    return Math.ceil((routeMi / speedMph) * 60);
  }

  private speedFor(mode: SupportedTravelMode): number | null {
    switch (mode) {
      case "WALK":
        return this.walkSpeedMph;
      case "TRANSIT":
        return this.transitSpeedMph;
      case "BICYCLE":
        return this.bicycleSpeedMph;
      default:
        return null;
    }
  }

  private circuityFor(mode: SupportedTravelMode): number | null {
    switch (mode) {
      case "WALK":
      case "TRANSIT":
      case "BICYCLE":
        return this.walkCircuity;
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
