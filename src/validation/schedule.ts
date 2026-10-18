import type { StopType } from "../retrieval";
import type { Candidate } from "./candidate";
import type { TravelMode } from "./common";
import { DEFAULT_PARTY_SIZE, DEFAULT_PRICE_RANGES } from "./defaults";
import type { Intent } from "./intent";
import type { ItineraryOption } from "./itinerary";
import { isOpenDuringSlot } from "./open-hours";
import type { TravelCalculator } from "./travel";
import type { ValidationErrorCode } from "./validation-error";

/**
 * Shared clock owner for the filter-only eval assembler and the plan-card
 * expander. Visit lengths, open-slot walk, and party cost shares live here
 * so both paths stamp the same minutes and dollars.
 */

export const MS_PER_MINUTE = 60_000;
export const SCHEDULE_STEP_MINUTES = 15;

/** Fixed visit length per stop type. */
export const STOP_MINUTES = {
  dinner: 90,
  drinks: 60,
  bar: 60,
  dessert: 30,
  activity: 90,
} as const satisfies Record<StopType, number>;

export type ScheduleFailureCode = Extract<
  ValidationErrorCode,
  "closed" | "over_budget" | "travel_too_long" | "travel_unverified" | "travel_service_unavailable"
>;

export interface ScheduledStop {
  readonly candidate: Candidate;
  readonly startMs: number;
  readonly endMs: number;
  /** Minutes from the previous stop. 0 for the first. */
  readonly legMinutes: number;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** First quarter hour from `notBeforeMs` at which the venue is open for the whole visit, inside the window. */
export function firstOpenStart(candidate: Candidate, notBeforeMs: number, windowEndMs: number): number | null {
  const lengthMs = STOP_MINUTES[candidate.stopType] * MS_PER_MINUTE;
  for (let startMs = notBeforeMs; startMs + lengthMs <= windowEndMs; startMs += SCHEDULE_STEP_MINUTES * MS_PER_MINUTE) {
    if (isOpenDuringSlot(candidate, iso(startMs), iso(startMs + lengthMs))) {
      return startMs;
    }
  }
  return null;
}

/** Per-person price band times party size, or null when Places gave no usable level. */
export function costBand(candidate: Candidate): readonly [number, number] | null {
  const level = candidate.priceLevel;
  if (level === null || level === "PRICE_LEVEL_UNSPECIFIED") {
    return null;
  }
  const [low, high] = DEFAULT_PRICE_RANGES[level];
  return [low * DEFAULT_PARTY_SIZE, high * DEFAULT_PARTY_SIZE];
}

/** An even share of the budget, pulled inside the venue's price band so the plausibility check can pass. */
export function estimatedCost(candidate: Candidate, budgetUsd: number, stopCount: number): number {
  const share = Math.floor(budgetUsd / stopCount);
  const band = costBand(candidate);
  return band === null ? share : Math.min(Math.max(share, band[0]), band[1]);
}

async function hopMinutes(
  travel: TravelCalculator,
  mode: TravelMode,
  from: ScheduledStop,
  to: Candidate,
  signal: AbortSignal | undefined,
): Promise<number | null> {
  try {
    const [minutes] = await travel.calculateMinutes(
      [{ from: from.candidate.location, to: to.location, mode, departureTime: iso(from.endMs) }],
      signal,
    );
    return minutes ?? null;
  } catch {
    return null;
  }
}

export function toItineraryOption(
  placed: readonly ScheduledStop[],
  intent: Intent,
  mode: TravelMode,
  theme: string,
  whys: readonly string[],
): ItineraryOption {
  return {
    theme,
    stops: placed.map((stop, index) => {
      const next = placed[index + 1];
      return {
        placeId: stop.candidate.placeId,
        name: stop.candidate.name,
        start: iso(stop.startMs),
        end: iso(stop.endMs),
        estimatedCostUsd: estimatedCost(stop.candidate, intent.budgetUsd, placed.length),
        why: whys[index] ?? `Selected ${stop.candidate.stopType}`,
        travelToNext: next === undefined ? null : { mode, minutes: next.legMinutes },
      };
    }),
  };
}

/**
 * Schedule an ordered list of already-chosen candidates into one option.
 * Tries each mode in order until one fits open hours and budget.
 */
export async function scheduleChosenStops(input: {
  readonly intent: Intent;
  readonly candidates: readonly Candidate[];
  readonly travel: TravelCalculator;
  readonly modes: readonly TravelMode[];
  readonly theme: string;
  readonly whys: readonly string[];
  readonly signal?: AbortSignal;
}): Promise<
  | { readonly kind: "ready"; readonly option: ItineraryOption; readonly mode: TravelMode }
  | { readonly kind: "failed"; readonly code: ScheduleFailureCode }
> {
  const window = { startMs: Date.parse(input.intent.window.start), endMs: Date.parse(input.intent.window.end) };
  let lastFailure: ScheduleFailureCode = "closed";
  for (const mode of input.modes) {
    const placed: ScheduledStop[] = [];
    let failed: ScheduleFailureCode | null = null;
    for (const candidate of input.candidates) {
      const previous = placed.at(-1);
      const leg =
        previous === undefined ? 0 : await hopMinutes(input.travel, mode, previous, candidate, input.signal);
      if (previous !== undefined && leg === null) {
        failed = "travel_unverified";
        break;
      }
      const notBeforeMs = previous === undefined ? window.startMs : previous.endMs + (leg ?? 0) * MS_PER_MINUTE;
      const startMs = firstOpenStart(candidate, notBeforeMs, window.endMs);
      if (startMs === null) {
        failed = "closed";
        break;
      }
      placed.push({
        candidate,
        startMs,
        endMs: startMs + STOP_MINUTES[candidate.stopType] * MS_PER_MINUTE,
        legMinutes: leg ?? 0,
      });
    }
    if (failed !== null) {
      lastFailure = failed;
      continue;
    }
    if (placed.length !== input.candidates.length) {
      lastFailure = "closed";
      continue;
    }
    const totalCost = placed.reduce(
      (sum, stop) => sum + estimatedCost(stop.candidate, input.intent.budgetUsd, placed.length),
      0,
    );
    if (totalCost > input.intent.budgetUsd) {
      lastFailure = "over_budget";
      continue;
    }
    return {
      kind: "ready",
      mode,
      option: toItineraryOption(placed, input.intent, mode, input.theme, input.whys),
    };
  }
  return { kind: "failed", code: lastFailure };
}
