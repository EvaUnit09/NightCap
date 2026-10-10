import "server-only";

import { MAX_TRAVEL_LEGS_PER_REQUEST_DEFAULT } from "./bounds";
import {
  normalizeTravelMode,
  TravelServiceUnavailableError,
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

/** Contract names are the Routes `travelMode` values. */
const TRAVEL_MODE: Record<SupportedTravelMode, SupportedTravelMode> = {
  TRANSIT: "TRANSIT",
  BICYCLE: "BICYCLE",
  WALK: "WALK",
};

export interface RoutesMatrixTravelOptions {
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Cap on billed 1×1 elements per calculateMinutes. Default 4 (#28). */
  maxLegs?: number;
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
 * v1 sends TRANSIT, BICYCLE, and WALK as Routes `travelMode` (identity).
 * Any other mode returns null without fetching.
 *
 * Fail-closed: unsupported mode, ROUTE_NOT_FOUND, element status, missing
 * duration, or malformed body → null. Missing key, HTTP 4xx/5xx, timeout,
 * or abort → `TravelServiceUnavailableError`. More than `maxLegs` hops
 * refuses to bill: throws before any fetch (#28).
 */
export class RoutesMatrixTravelCalculator implements TravelCalculator {
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly maxLegs: number;

  constructor(options: RoutesMatrixTravelOptions = {}) {
    if (
      options.maxLegs !== undefined &&
      (!Number.isInteger(options.maxLegs) || options.maxLegs <= 0)
    ) {
      throw new Error(
        `maxLegs must be a positive number (got ${String(options.maxLegs)})`
      );
    }
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxLegs = options.maxLegs ?? MAX_TRAVEL_LEGS_PER_REQUEST_DEFAULT;
  }

  async calculateMinutes(
    legs: readonly TravelLeg[],
    signal?: AbortSignal
  ): Promise<Array<number | null>> {
    if (legs.length > this.maxLegs) {
      throw new Error(
        `At most ${this.maxLegs} travel legs per request; refused to bill ${legs.length}`
      );
    }
    if (!this.apiKey) {
      throw new TravelServiceUnavailableError("GOOGLE_PLACES_API_KEY is missing");
    }
    if (signal?.aborted) {
      throw new TravelServiceUnavailableError("Routes request aborted");
    }

    const results: Array<number | null> = legs.map(() => null);
    const batch = new AbortController();
    const onParentAbort = () => batch.abort();
    signal?.addEventListener("abort", onParentAbort, { once: true });

    // In-call memo only. A new Map per calculateMinutes stays inside
    // Google's caching terms (no cross-request store).
    const memo = new Map<string, Promise<number | null>>();

    try {
      await Promise.all(
        legs.map(async (leg, index) => {
          const mode = normalizeTravelMode(leg.mode);
          if (!leg.from || !leg.to || mode === null) {
            return;
          }
          const normalized = { ...leg, mode };
          const key = memoKey(normalized);
          let pending = memo.get(key);
          if (!pending) {
            pending = this.matrixForLeg(normalized, batch.signal);
            memo.set(key, pending);
          }
          results[index] = await pending;
        })
      );
      return results;
    } catch (error) {
      batch.abort();
      if (error instanceof TravelServiceUnavailableError) {
        throw error;
      }
      throw new TravelServiceUnavailableError(
        error instanceof Error ? error.message : "Routes request failed"
      );
    } finally {
      signal?.removeEventListener("abort", onParentAbort);
    }
  }

  private async matrixForLeg(
    leg: TravelLeg & { mode: SupportedTravelMode },
    signal?: AbortSignal
  ): Promise<number | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onParentAbort = () => controller.abort();
    signal?.addEventListener("abort", onParentAbort, { once: true });

    try {
      const body: Record<string, unknown> = {
        origins: [waypoint(leg.from!)],
        destinations: [waypoint(leg.to!)],
        travelMode: TRAVEL_MODE[leg.mode],
      };
      if (leg.mode === "TRANSIT" && leg.departureTime) {
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
        throw new TravelServiceUnavailableError(`Routes HTTP ${response.status}`);
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
    } catch (error) {
      if (error instanceof TravelServiceUnavailableError) {
        throw error;
      }
      throw new TravelServiceUnavailableError(
        error instanceof Error ? error.message : "Routes request failed"
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onParentAbort);
    }
  }
}

function memoKey(leg: TravelLeg & { mode: SupportedTravelMode }): string {
  return JSON.stringify({
    from: leg.from,
    to: leg.to,
    mode: leg.mode,
    departureTime: leg.mode === "TRANSIT" ? (leg.departureTime ?? null) : null,
  });
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
