import type { Candidate } from "../validation/candidate";
import { priceLevelSchema } from "../validation/common";
import type { PriceLevelKey } from "../validation/defaults";
import type { Intent } from "../validation/intent";
import type { ToolInput } from "../validation/tool-input";
import type { PlacesSearchRequest } from "./places-client";
import { STOP_TYPE_PLACE_TYPES, stopTypeQueryTerm, type StopType, type StopTypes } from "./stop-types";

export type PriceLevel = NonNullable<Candidate["priceLevel"]>;

/** ISO datetimes with an offset, already validated upstream. */
export interface TimeSlot {
  readonly start: string;
  readonly end: string;
}

/**
 * The one retrieval question. Both callers reduce to it, so nothing below
 * retrieve.ts knows whether an Intent or a tool call asked.
 */
export interface VenueQuery {
  /** Free text. Sent to Google inside textQuery; never put on a span. */
  readonly area: string;
  readonly stopTypes: StopTypes;
  readonly slot: TimeSlot;
  /** null and PRICE_LEVEL_UNSPECIFIED always pass, as in the validator. */
  readonly acceptedPriceLevels: ReadonlySet<PriceLevel>;
  /** Lowercased, trimmed, deduped. Empty for agent tool calls. */
  readonly vibeTags: readonly string[];
}

export type SearchVenuesInput = Extract<ToolInput, { tool: "search_venues" }>;
export type PriceRangesByLevel = Readonly<Record<PriceLevelKey, readonly [number, number]>>;

const PRICE_LEVELS: readonly PriceLevelKey[] = priceLevelSchema.exclude(["PRICE_LEVEL_UNSPECIFIED"]).options;
const MS_PER_MINUTE = 60_000;

function toStopTypes(stopTypes: readonly StopType[]): StopTypes {
  const [first, ...rest] = [...new Set(stopTypes)];
  if (first === undefined) {
    throw new RangeError("A venue query needs at least one stop type");
  }
  return [first, ...rest];
}

function normalizeTags(tags: readonly string[]): readonly string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0))];
}

/**
 * Pipeline adapter. The slot is the whole night window. The price band is
 * every level whose per-person minimum fits the per-person budget: a level
 * outside it can never pass the validator's implausible_cost check, and a
 * level inside it can, so the filter is never stricter than the validator.
 */
export function queryFromIntent(
  intent: Intent,
  ctx: { readonly priceRanges: PriceRangesByLevel; readonly partySize: number },
): VenueQuery {
  const perPersonUsd = intent.budgetUsd / ctx.partySize;
  return {
    area: intent.area,
    stopTypes: toStopTypes(intent.stopTypes),
    slot: intent.window,
    acceptedPriceLevels: new Set(PRICE_LEVELS.filter((level) => ctx.priceRanges[level][0] <= perPersonUsd)),
    vibeTags: normalizeTags(intent.vibeTags),
  };
}

/**
 * Agent adapter. One stop type and a slot of [openAt, openAt +
 * minOpenMinutes]. PRICE_LEVEL_UNSPECIFIED means the agent named no level,
 * so every level is accepted.
 */
export function queryFromSearchVenues(
  input: SearchVenuesInput,
  ctx: { readonly minOpenMinutes: number },
): VenueQuery {
  const startMs = Date.parse(input.openAt);
  return {
    area: input.area,
    stopTypes: [input.category],
    slot: { start: input.openAt, end: new Date(startMs + ctx.minOpenMinutes * MS_PER_MINUTE).toISOString() },
    acceptedPriceLevels: new Set(input.priceLevel === "PRICE_LEVEL_UNSPECIFIED" ? PRICE_LEVELS : [input.priceLevel]),
    vibeTags: [],
  };
}

/** One logical Text Search and the stop types it is responsible for. */
export interface SearchSpec {
  readonly request: PlacesSearchRequest;
  readonly covers: StopTypes;
}

function textQuery(stopTypes: StopTypes, query: VenueQuery): string {
  const terms = stopTypes.map(stopTypeQueryTerm).join(", ");
  return [`${terms} in ${query.area}`, ...query.vibeTags].join(", ");
}

/** The first search: one combined query covering every stop type. */
export function initialSearch(query: VenueQuery): SearchSpec {
  const [only, ...others] = query.stopTypes;
  return {
    request: {
      textQuery: textQuery(query.stopTypes, query),
      includedType: others.length === 0 ? STOP_TYPE_PLACE_TYPES[only][0] : undefined,
    },
    covers: query.stopTypes,
  };
}

/**
 * One targeted search per starved stop type, in query order, at most
 * `budget` of them. A single-stop query's first search is already the
 * targeted one, so repeating it would only bill twice for the same page.
 */
export function refillSearches(query: VenueQuery, starved: readonly StopType[], budget: number): readonly SearchSpec[] {
  if (query.stopTypes.length === 1) {
    return [];
  }
  return query.stopTypes
    .filter((stopType) => starved.includes(stopType))
    .slice(0, Math.max(budget, 0))
    .map((stopType) => ({
      request: { textQuery: textQuery([stopType], query), includedType: STOP_TYPE_PLACE_TYPES[stopType][0] },
      covers: [stopType],
    }));
}
