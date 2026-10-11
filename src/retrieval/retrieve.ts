import { withStage } from "../monitoring";
import type { Candidate } from "../validation/candidate";
import { PlacesError, type PlaceRecord, type PlacesClient, type PlacesErrorCode } from "./places-client";
import { initialSearch, refillSearches, type SearchSpec, type VenueQuery } from "./query";
import { rankCandidates, type RankedByStopType, type RankSettings } from "./rank";
import type { StopType } from "./stop-types";

export type GapReason = "no_matches" | "places_rate_limited" | "places_timeout" | "places_unavailable";

/** Exactly one per requested stop type, so "partial" is read off the map, not stored. */
export type StopOutcome =
  | { readonly kind: "ranked"; readonly candidates: readonly [Candidate, ...Candidate[]] }
  | { readonly kind: "gap"; readonly reason: GapReason };

export interface Retrieval {
  readonly byStopType: ReadonlyMap<StopType, StopOutcome>;
  /** Text Search HTTP requests sent, retries included: an upper bound on billed calls. */
  readonly placesRequests: number;
}

export interface RetrievalSettings extends RankSettings {
  /** Logical searches per request: the combined search plus refills. */
  readonly maxSearches: number;
  /** A stop type with fewer survivors than this gets a refill search. */
  readonly minPerStop: number;
  readonly retryDelayMs: number;
}

export interface RetrievalDeps {
  readonly places: PlacesClient;
  readonly settings: RetrievalSettings;
  /** Injected so tests do not wait on retryDelayMs. Rejects when `signal` aborts. */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

type SearchResult =
  | {
      readonly ok: true;
      readonly places: readonly PlaceRecord[];
      readonly requests: number;
      /** The failure a retry recovered from, if any. */
      readonly recoveredFrom: PlacesError | null;
    }
  | { readonly ok: false; readonly error: PlacesError; readonly requests: number };

const GAP_REASON: Readonly<Record<PlacesErrorCode, Exclude<GapReason, "no_matches">>> = {
  rate_limited: "places_rate_limited",
  timeout: "places_timeout",
  http_error: "places_unavailable",
  malformed: "places_unavailable",
  missing_key: "places_unavailable",
};

function isRetryable(error: unknown): error is PlacesError {
  return error instanceof PlacesError && (error.code === "rate_limited" || error.code === "timeout");
}

/**
 * One logical call is one places.search span. A 429 or timeout is retried
 * once inside it. A final failure throws inside the span (so the span is an
 * error with the PlacesError code) and comes back out as a value. Anything
 * that is not a PlacesError, i.e. a parent abort, propagates.
 */
async function searchWithRetry(spec: SearchSpec, deps: RetrievalDeps, signal?: AbortSignal): Promise<SearchResult> {
  let firstFailure: PlacesError | null = null;
  const run = async (): Promise<readonly PlaceRecord[]> => {
    try {
      return await deps.places.searchText(spec.request, signal);
    } catch (error) {
      if (!isRetryable(error)) throw error;
      firstFailure = error;
      await deps.sleep(deps.settings.retryDelayMs, signal);
      return deps.places.searchText(spec.request, signal);
    }
  };
  try {
    const places = await withStage({ stage: "places.search", cache: "miss" }, run);
    return { ok: true, places, requests: firstFailure === null ? 1 : 2, recoveredFrom: firstFailure };
  } catch (error) {
    if (!(error instanceof PlacesError)) throw error;
    return { ok: false, error, requests: firstFailure === null ? 1 : 2 };
  }
}

function starvedStopTypes(ranked: RankedByStopType, query: VenueQuery, minPerStop: number): readonly StopType[] {
  return query.stopTypes.filter((stopType) => (ranked.get(stopType)?.length ?? 0) < minPerStop);
}

function outcomeFor(candidates: readonly Candidate[], failure: PlacesError | undefined): StopOutcome {
  const [first, ...rest] = candidates;
  if (first !== undefined) {
    return { kind: "ranked", candidates: [first, ...rest] };
  }
  return { kind: "gap", reason: failure === undefined ? "no_matches" : GAP_REASON[failure.code] };
}

function failuresByStopType(
  refills: readonly SearchSpec[],
  results: readonly SearchResult[],
): ReadonlyMap<StopType, PlacesError> {
  return new Map(
    refills.flatMap((spec, index) => {
      const result = results[index];
      return result.ok ? [] : spec.covers.map((stopType) => [stopType, result.error] as const);
    }),
  );
}

function assemble(
  query: VenueQuery,
  ranked: RankedByStopType,
  failures: ReadonlyMap<StopType, PlacesError>,
  placesRequests: number,
): Retrieval {
  return {
    byStopType: new Map(
      query.stopTypes.map((stopType) => [stopType, outcomeFor(ranked.get(stopType) ?? [], failures.get(stopType))]),
    ),
    placesRequests,
  };
}

/**
 * The one retrieval path for the pipeline, the agent's search_venues, and
 * eval. One combined search; then targeted refills, in parallel and capped
 * at maxSearches - 1, for stop types under minPerStop. Refills are skipped
 * when the combined search needed a retry: a 429 will not clear in
 * retryDelayMs. A failed refill keeps what the combined search found.
 * Places failures become gaps; only a parent abort throws. Every candidate
 * comes from a Places response made during this call.
 */
export async function retrieveVenues(query: VenueQuery, deps: RetrievalDeps, signal?: AbortSignal): Promise<Retrieval> {
  const { settings } = deps;
  const initial = await searchWithRetry(initialSearch(query), deps, signal);
  if (!initial.ok) {
    const failures = new Map(query.stopTypes.map((stopType) => [stopType, initial.error] as const));
    return assemble(query, new Map(), failures, initial.requests);
  }
  const starved = starvedStopTypes(rankCandidates(initial.places, query, settings), query, settings.minPerStop);
  const blocker = initial.recoveredFrom;
  const refills = blocker === null ? refillSearches(query, starved, settings.maxSearches - 1) : [];
  const results = await Promise.all(refills.map((spec) => searchWithRetry(spec, deps, signal)));
  const pool = [initial.places, ...results.map((result) => (result.ok ? result.places : []))].flat();
  const ranked = await withStage({ stage: "rerank" }, () => rankCandidates(pool, query, settings));
  const failures =
    blocker === null
      ? failuresByStopType(refills, results)
      : new Map(starved.map((stopType) => [stopType, blocker] as const));
  const requests = results.reduce((total, result) => total + result.requests, initial.requests);
  return assemble(query, ranked, failures, requests);
}

/** Flat, placeId-unique list for the validator and the invented-venue gate. */
export function allCandidates(retrieval: Retrieval): readonly Candidate[] {
  return [...retrieval.byStopType.values()].flatMap((outcome) =>
    outcome.kind === "ranked" ? outcome.candidates : [],
  );
}
