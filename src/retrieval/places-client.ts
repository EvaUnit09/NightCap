import { z } from "zod";

import { candidateSchema, type Candidate } from "../validation/candidate";
import { businessStatusSchema, placeIdSchema, priceLevelSchema } from "../validation/common";

/** POST https://places.googleapis.com/v1/places:searchText */
export const PLACES_TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";

/**
 * Every place field retrieval reads, and nothing else: the request field
 * mask and the parser are both built from this list. rating,
 * userRatingCount, priceLevel and regularOpeningHours put the request on
 * the Enterprise SKU ($0.035), kept for the novelty re-rank (#25, #30).
 */
export const PLACES_READ_FIELDS = [
  "id",
  "displayName",
  "businessStatus",
  "priceLevel",
  "rating",
  "userRatingCount",
  "location",
  "regularOpeningHours",
  "types",
  "primaryType",
] as const;

type PlacesReadField = (typeof PLACES_READ_FIELDS)[number];

export const PLACES_SEARCH_FIELD_MASK = PLACES_READ_FIELDS.map((field) => `places.${field}`).join(",");

/** Google's maximum page size. One page per search; each page is billed. */
const PLACES_PAGE_SIZE = 20;
const CANDIDATE_TYPES_MAX = 20;

/** Five boroughs. Results outside it are never returned, not just down-ranked. */
export const NYC_LOCATION_RESTRICTION = {
  rectangle: {
    low: { latitude: 40.4774, longitude: -74.2591 },
    high: { latitude: 40.9176, longitude: -73.7004 },
  },
} as const;

/** One billed Text Search. */
export interface PlacesSearchRequest {
  readonly textQuery: string;
  readonly includedType: string | undefined;
}

/**
 * A place as parsed from Google. The candidate lacks stopType (retrieval
 * assigns it); the ranking inputs never reach the strict Candidate.
 */
export interface PlaceRecord {
  readonly candidate: Omit<Candidate, "stopType">;
  readonly primaryType: string | null;
  /** 0-based position in Google's relevance order for its search. */
  readonly searchRank: number;
  /** Number of places in that search's page. */
  readonly pageSize: number;
}

/** Closed set. Doubles as the safe error_code on a failed span. */
export type PlacesErrorCode = "rate_limited" | "timeout" | "http_error" | "malformed" | "missing_key";

export class PlacesError extends Error {
  constructor(
    readonly code: PlacesErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PlacesError";
  }
}

export interface PlacesClientOptions {
  readonly apiKey: string | undefined;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

/** Each call is exactly one HTTP request. No retry, no span, no cache. */
export interface PlacesClient {
  searchText(request: PlacesSearchRequest, signal?: AbortSignal): Promise<readonly PlaceRecord[]>;
}

const pointSchema = z.object({
  day: z.int().min(0).max(6),
  hour: z.int().min(0).max(23),
  minute: z.int().min(0).max(59),
});

const placeWireShape = {
  id: placeIdSchema,
  displayName: z.object({ text: z.string() }),
  businessStatus: businessStatusSchema,
  priceLevel: priceLevelSchema.optional(),
  rating: z.number().optional(),
  userRatingCount: z.int().nonnegative().optional(),
  location: z.object({ latitude: z.number(), longitude: z.number() }),
  regularOpeningHours: z
    .object({ periods: z.array(z.object({ open: pointSchema, close: pointSchema.optional() })).optional() })
    .optional(),
  types: z.array(z.string()),
  primaryType: z.string().optional(),
} satisfies Record<PlacesReadField, z.ZodType>;

const placeWireSchema = z.object(placeWireShape);
const searchBodySchema = z.object({ places: z.array(z.unknown()).optional() });
const placeCandidateSchema = candidateSchema.omit({ stopType: true });

type PlaceWire = z.infer<typeof placeWireSchema>;
type WirePoint = z.infer<typeof pointSchema>;

function toPoint(point: WirePoint): Candidate["openingHours"][number]["open"] {
  return { day: point.day, hour: point.hour, minute: point.minute };
}

function toCandidate(wire: PlaceWire): unknown {
  const periods = wire.regularOpeningHours?.periods ?? [];
  return {
    placeId: wire.id,
    name: wire.displayName.text,
    businessStatus: wire.businessStatus,
    priceLevel: wire.priceLevel ?? null,
    rating: wire.rating ?? null,
    reviewCount: wire.userRatingCount ?? 0,
    location: { lat: wire.location.latitude, lng: wire.location.longitude },
    openingHours: periods.map((period) =>
      period.close === undefined
        ? { open: toPoint(period.open) }
        : { open: toPoint(period.open), close: toPoint(period.close) },
    ),
    types: wire.types.slice(0, CANDIDATE_TYPES_MAX),
  };
}

/**
 * Boundary parser for one place. A malformed place is dropped (null) so one
 * bad row cannot sink the search. Period date/truncated are not copied, so
 * the strict Candidate schema holds.
 */
export function parsePlace(raw: unknown, searchRank: number, pageSize: number): PlaceRecord | null {
  const wire = placeWireSchema.safeParse(raw);
  if (!wire.success) {
    return null;
  }
  const candidate = placeCandidateSchema.safeParse(toCandidate(wire.data));
  if (!candidate.success) {
    return null;
  }
  return { candidate: candidate.data, primaryType: wire.data.primaryType ?? null, searchRank, pageSize };
}

/** A whole-body shape failure is `malformed`; Google omits `places` when nothing matched. */
export function parseSearchBody(body: unknown): readonly PlaceRecord[] {
  const parsed = searchBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new PlacesError("malformed", "Places Text Search body is not the documented shape");
  }
  const places = parsed.data.places ?? [];
  return places.flatMap((raw, index) => {
    const record = parsePlace(raw, index, places.length);
    return record === null ? [] : [record];
  });
}

function requestBody(request: PlacesSearchRequest): string {
  return JSON.stringify({
    textQuery: request.textQuery,
    ...(request.includedType === undefined ? {} : { includedType: request.includedType }),
    pageSize: PLACES_PAGE_SIZE,
    locationRestriction: NYC_LOCATION_RESTRICTION,
  });
}

async function readSearchResponse(response: Response): Promise<readonly PlaceRecord[]> {
  if (response.status === 429) {
    throw new PlacesError("rate_limited", "Places HTTP 429");
  }
  if (!response.ok) {
    throw new PlacesError("http_error", `Places HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PlacesError("malformed", "Places body is not JSON");
  }
  return parseSearchBody(body);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Places request aborted", "AbortError");
}

/**
 * Text Search over fetch, shaped like RoutesMatrixTravelCalculator. A parent
 * abort rethrows the parent's reason (never a PlacesError), so callers can
 * tell a cancelled request from a Places failure.
 */
export function createPlacesClient(options: PlacesClientOptions): PlacesClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async searchText(request, signal) {
      if (!options.apiKey) {
        throw new PlacesError("missing_key", "GOOGLE_PLACES_API_KEY is missing");
      }
      if (signal?.aborted) {
        throw abortReason(signal);
      }
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeoutMs);
      const onParentAbort = () => controller.abort();
      signal?.addEventListener("abort", onParentAbort, { once: true });
      try {
        const response = await fetchImpl(PLACES_TEXT_SEARCH_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": options.apiKey,
            "X-Goog-FieldMask": PLACES_SEARCH_FIELD_MASK,
          },
          body: requestBody(request),
          signal: controller.signal,
        });
        return await readSearchResponse(response);
      } catch (error) {
        throw classifyFailure(error, signal, timedOut);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onParentAbort);
      }
    },
  };
}

function classifyFailure(error: unknown, signal: AbortSignal | undefined, timedOut: boolean): unknown {
  if (signal?.aborted) {
    return abortReason(signal);
  }
  if (timedOut) {
    return new PlacesError("timeout", "Places request timed out");
  }
  if (error instanceof PlacesError) {
    return error;
  }
  return new PlacesError("http_error", "Places request failed before a response");
}
