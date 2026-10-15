import "server-only";

/**
 * Places Text Search Enterprise is $0.035 per request (decision #33).
 * Stored as micros so the price is not a binary float.
 */
export const PLACES_TEXT_SEARCH_MICROS = 35_000;

/** Routes Essentials is $0.005 per 1×1 matrix element (decision #44). */
export const ROUTES_ESSENTIALS_HOP_MICROS = 5_000;

/** Place Details Enterprise is $20 per 1,000: the hydrate mask asks for rating and priceLevel. */
export const PLACE_DETAILS_MICROS = 20_000;

const MICROS_PER_USD = 1_000_000;
const HOUR_MS = 3_600_000;

const BILLED_TRAVEL_MODES = new Set(["TRANSIT", "BICYCLE", "WALK"]);

export interface VendorSpend {
  readonly modelUsd: number;
  readonly placesTextSearches: number;
  readonly routesHops: number;
}

export function usdToMicros(usd: number): number {
  return Math.round(usd * MICROS_PER_USD);
}

export function dailySpendFraction(micros: number, capUsd: number): number {
  const capMicros = usdToMicros(capUsd);
  if (!Number.isSafeInteger(capMicros) || capMicros <= 0) {
    throw new Error("daily spend cap must be a positive USD amount");
  }
  if (!Number.isSafeInteger(micros) || micros < 0) {
    throw new Error("daily spend micros must be a non-negative integer");
  }
  return micros / capMicros;
}

/** Model list price plus Places Text Search plus Routes Essentials. */
export function vendorMicros(spend: VendorSpend): number {
  return (
    usdToMicros(spend.modelUsd) +
    spend.placesTextSearches * PLACES_TEXT_SEARCH_MICROS +
    spend.routesHops * ROUTES_ESSENTIALS_HOP_MICROS
  );
}

const SPEND_DAY_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });

export function spendDay(nowMs: number): string {
  return SPEND_DAY_FORMAT.format(nowMs);
}

export function hourWindowMs(): number {
  return HOUR_MS;
}

/**
 * First address in `x-forwarded-for`, else `x-real-ip`.
 * Missing or odd values share one bucket so a hidden client is not unlimited.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const candidate = (forwarded?.split(",")[0] ?? request.headers.get("x-real-ip") ?? "").trim();
  if (candidate.length === 0 || candidate.length > 64) return "unknown";
  if (!/^[A-Za-z0-9:.]+$/.test(candidate)) return "unknown";
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

/**
 * Hops `RoutesMatrixTravelCalculator` would bill for one validate call:
 * a supported mode, both ends resolved, TRANSIT departure kept distinct,
 * duplicates inside the call counted once.
 */
export function billableRoutesHops(input: {
  readonly itinerary: unknown;
  readonly candidates: unknown;
}): number {
  const locations = new Map<string, LatLng>();
  if (Array.isArray(input.candidates)) {
    for (const candidate of input.candidates) {
      if (!isRecord(candidate) || typeof candidate.placeId !== "string") continue;
      const location = candidate.location;
      if (!isRecord(location) || typeof location.lat !== "number" || typeof location.lng !== "number") continue;
      locations.set(candidate.placeId, { lat: location.lat, lng: location.lng });
    }
  }

  if (!isRecord(input.itinerary) || !Array.isArray(input.itinerary.options)) return 0;

  const seen = new Set<string>();
  for (const option of input.itinerary.options) {
    if (!isRecord(option) || !Array.isArray(option.stops)) continue;
    for (let index = 0; index < option.stops.length - 1; index += 1) {
      const stop = option.stops[index];
      const next = option.stops[index + 1];
      if (!isRecord(stop) || !isRecord(next)) continue;
      const travel = stop.travelToNext;
      if (!isRecord(travel) || typeof travel.mode !== "string" || !BILLED_TRAVEL_MODES.has(travel.mode)) continue;
      if (typeof stop.placeId !== "string" || typeof next.placeId !== "string") continue;
      const from = locations.get(stop.placeId);
      const to = locations.get(next.placeId);
      if (from === undefined || to === undefined) continue;
      const departure = travel.mode === "TRANSIT" && typeof stop.end === "string" ? stop.end : "";
      seen.add(JSON.stringify({ from, to, mode: travel.mode, departure }));
    }
  }
  return seen.size;
}
