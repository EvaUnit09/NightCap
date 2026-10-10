import "server-only";

import {
  isSupportedTravelMode,
  type SupportedTravelMode,
  type TravelCalculator,
  type TravelLeg,
} from "./travel";

/** POST https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix */
export const ROUTES_MATRIX_URL =
  "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";

/**
 * Essentials-only field mask. Omits Pro fields (distanceMeters, transitFare)
 * and never sends routingPreference (that field is only valid for DRIVE /
 * TWO_WHEELER and would fail WALK, BICYCLE, and TRANSIT requests).
 * Fields: https://developers.google.com/maps/documentation/routes/compute_route_matrix
 */
export const ROUTES_ESSENTIALS_FIELD_MASK =
  "originIndex,destinationIndex,duration,condition,status";

const TRAVEL_MODE: Record<SupportedTravelMode, "WALK" | "TRANSIT" | "BICYCLE"> =
  {
    walk: "WALK",
    transit: "TRANSIT",
    bicycle: "BICYCLE",
  };

export interface RoutesMatrixTravelOptions {
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface RouteMatrixElement {
  originIndex?: number;
  destinationIndex?: number;
  duration?: string;
  condition?: string;
  status?: { code?: number; message?: string };
}

/**
 * Production travel calculator. One billed element per consecutive hop: each
 * leg is a 1×1 computeRouteMatrix call. A request has one travelMode, so mixed
 * modes are never packed into one matrix (and never N×N).
 *
 * v1 maps walk → WALK, transit → TRANSIT, bicycle → BICYCLE. Any other mode
 * returns null without fetching.
 *
 * Fail-closed: unsupported mode, missing key, HTTP 4xx/5xx, timeout,
 * ROUTE_NOT_FOUND, element status, missing duration, or malformed body → null.
 */
export class RoutesMatrixTravelCalculator implements TravelCalculator {
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RoutesMatrixTravelOptions = {}) {
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async calculateMinutes(
    legs: readonly TravelLeg[]
  ): Promise<Array<number | null>> {
    const results: Array<number | null> = legs.map(() => null);
    if (!this.apiKey) {
      return results;
    }

    await Promise.all(
      legs.map(async (leg, index) => {
        if (!leg.from || !leg.to || !isSupportedTravelMode(leg.mode)) {
          return;
        }
        results[index] = await this.matrixForLeg(leg);
      })
    );

    return results;
  }

  private async matrixForLeg(
    leg: TravelLeg & { mode: SupportedTravelMode }
  ): Promise<number | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const body: Record<string, unknown> = {
        origins: [waypoint(leg.from!)],
        destinations: [waypoint(leg.to!)],
        travelMode: TRAVEL_MODE[leg.mode],
      };
      if (leg.mode === "transit" && leg.departureTime) {
        body.departureTime = leg.departureTime;
      }

      const response = await this.fetchImpl(ROUTES_MATRIX_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.apiKey!,
          "X-Goog-FieldMask": ROUTES_ESSENTIALS_FIELD_MASK,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        return null;
      }

      const parsed: unknown = await response.json();
      const elements = normalizeElements(parsed);
      if (elements === null) {
        return null;
      }

      const element = elements.find(
        (item) =>
          (item.originIndex ?? 0) === 0 && (item.destinationIndex ?? 0) === 0
      );
      if (!element) {
        return null;
      }
      return minutesFromElement(element);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

function waypoint(location: { lat: number; lng: number }) {
  return {
    waypoint: {
      location: {
        latLng: {
          latitude: location.lat,
          longitude: location.lng,
        },
      },
    },
  };
}

function normalizeElements(body: unknown): RouteMatrixElement[] | null {
  if (Array.isArray(body)) {
    return body as RouteMatrixElement[];
  }
  if (body && typeof body === "object" && "error" in body) {
    return null;
  }
  return null;
}

function minutesFromElement(element: RouteMatrixElement): number | null {
  if (element.condition === "ROUTE_NOT_FOUND") {
    return null;
  }
  if (element.status && element.status.code && element.status.code !== 0) {
    return null;
  }
  if (!element.duration) {
    return null;
  }
  const match = /^(-?\d+(?:\.\d+)?)s$/.exec(element.duration);
  if (!match) {
    return null;
  }
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  return Math.ceil(seconds / 60);
}
