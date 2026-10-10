import "server-only";

import type { TravelCalculator, TravelLeg } from "./travel";

/** POST https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix */
export const ROUTES_MATRIX_URL =
  "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";

/**
 * Essentials-only field mask. Omits Pro fields (distanceMeters, transitFare)
 * and does not send routingPreference (TRAFFIC_AWARE* is Pro).
 * Fields: https://developers.google.com/maps/documentation/routes/compute_route_matrix
 */
export const ROUTES_ESSENTIALS_FIELD_MASK =
  "originIndex,destinationIndex,duration,condition,status";

const TRAVEL_MODE: Record<TravelLeg["mode"], "WALK" | "TRANSIT" | "DRIVE"> = {
  walk: "WALK",
  transit: "TRANSIT",
  rideshare: "DRIVE",
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
 * Production travel calculator. Batches same-mode legs into one
 * computeRouteMatrix call. TRANSIT is supported on this endpoint
 * (https://developers.google.com/maps/documentation/routes/transit-rm).
 *
 * Fail-closed: missing key, HTTP 4xx/5xx, timeout, ROUTE_NOT_FOUND,
 * element status, missing duration, or malformed body → null for those legs.
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

    const groups = new Map<TravelLeg["mode"], number[]>();
    for (const [index, leg] of legs.entries()) {
      if (!leg.from || !leg.to) {
        continue;
      }
      const list = groups.get(leg.mode) ?? [];
      list.push(index);
      groups.set(leg.mode, list);
    }

    await Promise.all(
      [...groups.entries()].map(async ([mode, indices]) => {
        const minutes = await this.matrixForMode(
          mode,
          indices.map((index) => legs[index]!)
        );
        for (const [offset, index] of indices.entries()) {
          results[index] = minutes[offset] ?? null;
        }
      })
    );

    return results;
  }

  private async matrixForMode(
    mode: TravelLeg["mode"],
    legs: TravelLeg[]
  ): Promise<Array<number | null>> {
    const out: Array<number | null> = legs.map(() => null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(ROUTES_MATRIX_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.apiKey!,
          "X-Goog-FieldMask": ROUTES_ESSENTIALS_FIELD_MASK,
        },
        body: JSON.stringify({
          origins: legs.map((leg) => waypoint(leg.from!)),
          destinations: legs.map((leg) => waypoint(leg.to!)),
          travelMode: TRAVEL_MODE[mode],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        return out;
      }

      const body: unknown = await response.json();
      const elements = normalizeElements(body);
      if (elements === null) {
        return out;
      }

      for (const element of elements) {
        const origin = element.originIndex;
        const dest = element.destinationIndex;
        if (origin !== dest || origin === undefined || origin < 0 || origin >= legs.length) {
          continue;
        }
        out[origin] = minutesFromElement(element);
      }
      return out;
    } catch {
      return out;
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
