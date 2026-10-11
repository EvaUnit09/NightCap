import type { Candidate } from "../validation/candidate";
import { isOpenDuringSlot, parseISOToNYCTime } from "../validation/open-hours";
import type { PlaceRecord } from "./places-client";
import type { TimeSlot, VenueQuery } from "./query";
import { STOP_TYPE_PLACE_TYPES, type StopType, type StopTypes } from "./stop-types";

export interface RankSettings {
  readonly topK: number;
  readonly minOpenMinutes: number;
  readonly vibeWeight: number;
  readonly popularityWeight: number;
  /** Review count where the novelty penalty starts. */
  readonly reviewSoftCap: number;
}

export type RankedByStopType = ReadonlyMap<StopType, readonly Candidate[]>;

interface Scored {
  readonly candidate: Candidate;
  readonly score: number;
}

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_WEEK = 7 * 24 * 60;

interface TypeMatch {
  readonly stopType: StopType;
  readonly priority: number;
}

function matchPlaceType(placeType: string, stopTypes: StopTypes): TypeMatch | null {
  return stopTypes.reduce<TypeMatch | null>((best, stopType) => {
    const priority = STOP_TYPE_PLACE_TYPES[stopType].indexOf(placeType);
    if (priority < 0 || (best !== null && best.priority <= priority)) {
      return best;
    }
    return { stopType, priority };
  }, null);
}

/**
 * The one stop type a place serves, or null. primaryType wins; otherwise the
 * place type that ranks highest in the registry. A place yields at most one
 * Candidate, so the planner never sees one venue under two stop types.
 */
export function classify(place: PlaceRecord, stopTypes: StopTypes): StopType | null {
  const primary = place.primaryType === null ? null : matchPlaceType(place.primaryType, stopTypes);
  if (primary !== null) {
    return primary.stopType;
  }
  const best = place.candidate.types.reduce<TypeMatch | null>((current, placeType) => {
    const match = matchPlaceType(placeType, stopTypes);
    return match !== null && (current === null || match.priority < current.priority) ? match : current;
  }, null);
  return best?.stopType ?? null;
}

/**
 * Window starts worth testing: the slot start and every weekly opening that
 * falls inside the slot. Any open stretch inside the slot begins at one of
 * them, so testing these is exact. Openings are placed by NYC wall-clock
 * minute of week; isOpenDuringSlot still decides, so a DST shift can only
 * cost a missed start, never admit a closed venue.
 */
function windowStarts(candidate: Candidate, slot: TimeSlot, latestOffsetMinutes: number): readonly number[] {
  const startMs = Date.parse(slot.start);
  const startWall = parseISOToNYCTime(slot.start);
  if (startWall === null) {
    return [];
  }
  const slotMinuteOfWeek = startWall.day * 24 * 60 + startWall.minute;
  const openingOffsets = candidate.openingHours.flatMap(({ open }) => {
    const openMinuteOfWeek = open.day * 24 * 60 + open.hour * 60 + open.minute;
    const first = (openMinuteOfWeek - slotMinuteOfWeek + MINUTES_PER_WEEK) % MINUTES_PER_WEEK;
    const count = first > latestOffsetMinutes ? 0 : Math.floor((latestOffsetMinutes - first) / MINUTES_PER_WEEK) + 1;
    return Array.from({ length: count }, (_, week) => first + week * MINUTES_PER_WEEK);
  });
  return [0, ...openingOffsets].map((offset) => startMs + offset * MS_PER_MINUTE);
}

/**
 * Open for minOpenMinutes contiguous minutes somewhere in the slot, or for
 * the whole slot when it is shorter. Requiring the whole night window would
 * reject every dessert shop.
 */
export function isOpenLongEnough(candidate: Candidate, slot: TimeSlot, minOpenMinutes: number): boolean {
  const slotMinutes = (Date.parse(slot.end) - Date.parse(slot.start)) / MS_PER_MINUTE;
  if (!(slotMinutes > 0)) {
    return false;
  }
  const needed = Math.min(minOpenMinutes, slotMinutes);
  return windowStarts(candidate, slot, slotMinutes - needed).some((startMs) =>
    isOpenDuringSlot(
      candidate,
      new Date(startMs).toISOString(),
      new Date(startMs + needed * MS_PER_MINUTE).toISOString(),
    ),
  );
}

export function passesFilter(candidate: Candidate, query: VenueQuery, minOpenMinutes: number): boolean {
  if (candidate.businessStatus !== "OPERATIONAL") {
    return false;
  }
  const level = candidate.priceLevel;
  if (level !== null && level !== "PRICE_LEVEL_UNSPECIFIED" && !query.acceptedPriceLevels.has(level)) {
    return false;
  }
  return isOpenLongEnough(candidate, query.slot, minOpenMinutes);
}

function tokens(text: string): readonly string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0);
}

/** Share of vibe tags whose every word appears in the name or the place types. */
function vibeFit(candidate: Pick<Candidate, "name" | "types">, vibeTags: readonly string[]): number {
  if (vibeTags.length === 0) {
    return 0;
  }
  const placeTokens = new Set([...tokens(candidate.name), ...candidate.types.flatMap(tokens)]);
  const matched = vibeTags.filter((tag) => {
    const tagTokens = tokens(tag);
    return tagTokens.length > 0 && tagTokens.every((token) => placeTokens.has(token));
  });
  return matched.length / vibeTags.length;
}

/** 0 at or below the soft cap; log10 of the overshoot above it, capped at 1. */
function noveltyPenalty(reviewCount: number, reviewSoftCap: number): number {
  if (reviewCount <= reviewSoftCap) {
    return 0;
  }
  return Math.min(1, Math.log10(reviewCount / reviewSoftCap));
}

/** Google's order mapped to (0, 1]: the first result of a page scores 1. */
function relevanceOf(place: PlaceRecord): number {
  return 1 - place.searchRank / Math.max(place.pageSize, 1);
}

/** Google's relevance order + vibe fit - novelty penalty. */
export function score(place: PlaceRecord, vibeTags: readonly string[], settings: RankSettings): number {
  return (
    relevanceOf(place) +
    settings.vibeWeight * vibeFit(place.candidate, vibeTags) -
    settings.popularityWeight * noveltyPenalty(place.candidate.reviewCount, settings.reviewSoftCap)
  );
}

/** One record per placeId; the copy Google ranked more relevant wins. */
function dedupe(places: readonly PlaceRecord[]): readonly PlaceRecord[] {
  const best = places.reduce((byId, place) => {
    const seen = byId.get(place.candidate.placeId);
    return seen !== undefined && relevanceOf(seen) >= relevanceOf(place)
      ? byId
      : new Map([...byId, [place.candidate.placeId, place]]);
  }, new Map<string, PlaceRecord>());
  return [...best.values()];
}

/** Score, then fewer reviews, then placeId: ranking never depends on input order. */
function compareScored(left: Scored, right: Scored): number {
  return (
    right.score - left.score ||
    left.candidate.reviewCount - right.candidate.reviewCount ||
    (left.candidate.placeId < right.candidate.placeId ? -1 : left.candidate.placeId > right.candidate.placeId ? 1 : 0)
  );
}

function scoreEligible(places: readonly PlaceRecord[], query: VenueQuery, settings: RankSettings): readonly Scored[] {
  return dedupe(places).flatMap((place) => {
    const stopType = classify(place, query.stopTypes);
    if (stopType === null) {
      return [];
    }
    const candidate: Candidate = { ...place.candidate, stopType };
    if (!passesFilter(candidate, query, settings.minOpenMinutes)) {
      return [];
    }
    return [{ candidate, score: score(place, query.vibeTags, settings) }];
  });
}

/**
 * Dedupe, classify, filter, score, and keep the top K per stop type. Every
 * query stop type is a key, possibly with an empty list. Pure; the caller
 * wraps it in the rerank span.
 */
export function rankCandidates(
  places: readonly PlaceRecord[],
  query: VenueQuery,
  settings: RankSettings,
): RankedByStopType {
  const sorted = [...scoreEligible(places, query, settings)].sort(compareScored);
  return new Map(
    query.stopTypes.map((stopType) => [
      stopType,
      sorted
        .filter((scored) => scored.candidate.stopType === stopType)
        .slice(0, settings.topK)
        .map((scored) => scored.candidate),
    ]),
  );
}
