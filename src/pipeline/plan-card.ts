import type { Candidate } from "../validation/candidate";
import { oneLineSchema } from "../validation/common";
import type { Intent } from "../validation/intent";
import { itinerarySchemaFor, type Itinerary } from "../validation/itinerary";
import { scheduleChosenStops, type ScheduleFailureCode } from "../validation/schedule";
import type { TravelCalculator } from "../validation/travel";
import type { BoundaryParse } from "./stage-call";

/**
 * Slim plan card (Option A). The model returns venue refs + copy; deterministic
 * expand fills clocks, costs, names, and travel.
 */

declare const planRefBrand: unique symbol;
/** Minted only by buildPlanBrief. A parsed card may contain only these refs. */
export type PlanRef = string & { readonly [planRefBrand]: true };

export interface BriefVenue {
  readonly ref: PlanRef;
  readonly candidate: Candidate;
}

export interface PlanBrief {
  readonly venues: readonly BriefVenue[];
  /** The only ref assignment for this request. */
  readonly byRef: ReadonlyMap<PlanRef, Candidate>;
}

export interface PlanCardStop {
  readonly ref: PlanRef;
  readonly why: string;
}

export interface PlanCardOption {
  readonly theme: string;
  readonly stops: readonly PlanCardStop[];
}

/** Exactly two options. A third option is not representable on the card. */
export interface PlanCard {
  readonly options: readonly [PlanCardOption, PlanCardOption];
}

export type ExpandResult =
  | {
      readonly kind: "ready";
      readonly itinerary: Itinerary;
    }
  | {
      readonly kind: "none_schedulable";
      readonly failures: readonly [ScheduleFailureCode, ScheduleFailureCode];
    };

/** Retrieval order. Refs are decimal indexes. Empty input returns an empty brief. */
export function buildPlanBrief(candidates: readonly Candidate[]): PlanBrief {
  const venues: BriefVenue[] = candidates.map((candidate, index) => ({
    ref: String(index) as PlanRef,
    candidate,
  }));
  return {
    venues,
    byRef: new Map(venues.map((venue) => [venue.ref, venue.candidate])),
  };
}

function priceWord(candidate: Candidate): string {
  switch (candidate.priceLevel) {
    case "PRICE_LEVEL_FREE":
      return "free";
    case "PRICE_LEVEL_INEXPENSIVE":
      return "inexpensive";
    case "PRICE_LEVEL_MODERATE":
      return "moderate";
    case "PRICE_LEVEL_EXPENSIVE":
      return "expensive";
    case "PRICE_LEVEL_VERY_EXPENSIVE":
      return "very_expensive";
    default:
      return "unknown";
  }
}

/** One line per venue for the plan-card prompt. No openingHours. */
export function briefVenueLine(venue: BriefVenue): string {
  const { candidate, ref } = venue;
  const name = candidate.name.replace(/\s+/g, " ").trim();
  const types = candidate.types.slice(0, 3).join(",");
  return `${ref} ${candidate.stopType} "${name}" ${priceWord(candidate)} ${candidate.rating ?? "na"} ${candidate.reviewCount} ${types}`;
}

function parseCardStop(
  raw: unknown,
  brief: PlanBrief,
  intent: Intent,
  stopIndex: number,
  used: Set<PlanRef>,
): PlanCardStop | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.ref !== "string" || typeof record.why !== "string") {
    return null;
  }
  const why = oneLineSchema(200).safeParse(record.why);
  if (!why.success) {
    return null;
  }
  const ref = record.ref as PlanRef;
  const candidate = brief.byRef.get(ref);
  if (candidate === undefined || used.has(ref)) {
    return null;
  }
  if (candidate.stopType !== intent.stopTypes[stopIndex]) {
    return null;
  }
  used.add(ref);
  return { ref, why: why.data };
}

function parseCardOption(raw: unknown, brief: PlanBrief, intent: Intent, used: Set<PlanRef>): PlanCardOption | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.theme !== "string" || !Array.isArray(record.stops)) {
    return null;
  }
  const theme = oneLineSchema(80).safeParse(record.theme);
  if (!theme.success) {
    return null;
  }
  if (record.stops.length !== intent.stopTypes.length) {
    return null;
  }
  const stops: PlanCardStop[] = [];
  for (let i = 0; i < record.stops.length; i++) {
    const stop = parseCardStop(record.stops[i], brief, intent, i, used);
    if (stop === null) {
      return null;
    }
    stops.push(stop);
  }
  return { theme: theme.data, stops };
}

/**
 * Model boundary. Rejects unknown refs, a repeated ref, a stop whose
 * candidate.stopType differs from intent.stopTypes at that index, and any
 * option whose length differs from intent.stopTypes.length.
 */
export function parsePlanCard(
  json: unknown,
  brief: PlanBrief,
  intent: Intent,
): BoundaryParse<PlanCard> {
  if (typeof json !== "object" || json === null) {
    return { success: false };
  }
  const record = json as Record<string, unknown>;
  if (!Array.isArray(record.options) || record.options.length !== 2) {
    return { success: false };
  }
  const used = new Set<PlanRef>();
  const first = parseCardOption(record.options[0], brief, intent, used);
  const second = parseCardOption(record.options[1], brief, intent, used);
  if (first === null || second === null) {
    return { success: false };
  }
  return { success: true, data: { options: [first, second] } };
}

/**
 * Resolves refs through brief.byRef and schedules both options.
 * Returns ready only when both schedule and itinerarySchemaFor accepts the pair.
 */
export async function expandPlanCard(input: {
  readonly card: PlanCard;
  readonly brief: PlanBrief;
  readonly intent: Intent;
  readonly travel: TravelCalculator | undefined;
  readonly maxLegs: number;
  readonly signal?: AbortSignal;
}): Promise<ExpandResult> {
  if (input.travel === undefined) {
    return { kind: "none_schedulable", failures: ["travel_service_unavailable", "travel_service_unavailable"] };
  }
  const failures: ScheduleFailureCode[] = [];
  const scheduled = [];
  for (const option of input.card.options) {
    const candidates = option.stops.map((stop) => {
      const candidate = input.brief.byRef.get(stop.ref);
      if (candidate === undefined) {
        throw new Error(`expandPlanCard saw unknown ref ${stop.ref}`);
      }
      return candidate;
    });
    const result = await scheduleChosenStops({
      intent: input.intent,
      candidates,
      travel: input.travel,
      modes: ["WALK", "TRANSIT"],
      theme: option.theme,
      whys: option.stops.map((stop) => stop.why),
      signal: input.signal,
    });
    if (result.kind === "failed") {
      failures.push(result.code);
      continue;
    }
    scheduled.push(result.option);
  }
  if (scheduled.length < 2) {
    const a = failures[0] ?? "closed";
    const b = failures[1] ?? a;
    return { kind: "none_schedulable", failures: [a, b] };
  }
  const parsed = itinerarySchemaFor({ maxLegs: input.maxLegs }).safeParse({
    singleStop: input.intent.singleStop,
    options: scheduled.slice(0, 2),
  });
  if (!parsed.success) {
    return { kind: "none_schedulable", failures: ["closed", "closed"] };
  }
  return { kind: "ready", itinerary: parsed.data };
}
