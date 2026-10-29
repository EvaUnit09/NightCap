import type { StopType } from "../src/retrieval";
import type { Candidate } from "../src/validation/candidate";
import type { TravelMode } from "../src/validation/common";
import type { Intent } from "../src/validation/intent";
import type { ItineraryOption } from "../src/validation/itinerary";
import {
  MS_PER_MINUTE,
  STOP_MINUTES,
  estimatedCost,
  firstOpenStart,
  iso,
  type ScheduledStop,
} from "../src/validation/schedule";
import type { TravelCalculator } from "../src/validation/travel";

/**
 * The filter-only baseline's planner (build step 20): no model, just the
 * ranked retrieval pool. Each option takes the best unused candidate per
 * stop type, in the intent's stop-type order, and schedules it at the first
 * quarter hour it is open. Nothing here checks its own work; the real
 * validator does (see `judge.ts`).
 *
 * Clock helpers live in `src/validation/schedule.ts` so the plan-card
 * expander shares one owner.
 */

export interface AssembleContext {
  readonly travel: TravelCalculator;
  readonly mode: TravelMode;
  /** Options to try for, 2 or 3. Fewer come back when the pool runs out. */
  readonly optionCount: number;
}

type Pools = ReadonlyMap<StopType, readonly Candidate[]>;

/** The pool grouped by stop type, rank order kept (the flat list is ranked per type). */
export function poolsByStopType(candidates: readonly Candidate[]): Pools {
  return candidates.reduce<Map<StopType, Candidate[]>>((pools, candidate) => {
    pools.set(candidate.stopType, [...(pools.get(candidate.stopType) ?? []), candidate]);
    return pools;
  }, new Map());
}

async function legMinutes(
  ctx: AssembleContext,
  from: ScheduledStop,
  to: Candidate,
  signal: AbortSignal,
): Promise<number | null> {
  const [minutes] = await ctx.travel.calculateMinutes(
    [{ from: from.candidate.location, to: to.location, mode: ctx.mode, departureTime: iso(from.endMs) }],
    signal,
  );
  return minutes ?? null;
}

async function placeNext(
  ctx: AssembleContext,
  window: { readonly startMs: number; readonly endMs: number },
  previous: ScheduledStop | undefined,
  pool: readonly Candidate[],
  used: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<ScheduledStop | null> {
  for (const candidate of pool) {
    if (used.has(candidate.placeId)) {
      continue;
    }
    const leg = previous === undefined ? 0 : await legMinutes(ctx, previous, candidate, signal);
    if (leg === null) {
      continue;
    }
    const notBeforeMs = previous === undefined ? window.startMs : previous.endMs + leg * MS_PER_MINUTE;
    const startMs = firstOpenStart(candidate, notBeforeMs, window.endMs);
    if (startMs !== null) {
      return {
        candidate,
        startMs,
        endMs: startMs + STOP_MINUTES[candidate.stopType] * MS_PER_MINUTE,
        legMinutes: leg,
      };
    }
  }
  return null;
}

function toOption(placed: readonly ScheduledStop[], intent: Intent, mode: TravelMode, optionNumber: number): ItineraryOption {
  return {
    theme: `Top-ranked ${intent.stopTypes.join(" then ")} (${optionNumber})`,
    stops: placed.map((stop, index) => {
      const next = placed[index + 1];
      return {
        placeId: stop.candidate.placeId,
        name: stop.candidate.name,
        start: iso(stop.startMs),
        end: iso(stop.endMs),
        estimatedCostUsd: estimatedCost(stop.candidate, intent.budgetUsd, placed.length),
        why: `Ranked ${stop.candidate.stopType} match for the request`,
        travelToNext: next === undefined ? null : { mode, minutes: next.legMinutes },
      };
    }),
  };
}

async function buildOption(
  intent: Intent,
  pools: Pools,
  used: ReadonlySet<string>,
  ctx: AssembleContext,
  signal: AbortSignal,
): Promise<readonly ScheduledStop[] | null> {
  const window = { startMs: Date.parse(intent.window.start), endMs: Date.parse(intent.window.end) };
  const placed: ScheduledStop[] = [];
  for (const stopType of intent.stopTypes) {
    const next = await placeNext(ctx, window, placed.at(-1), pools.get(stopType) ?? [], used, signal);
    if (next === null) {
      return null;
    }
    placed.push(next);
  }
  return placed;
}

/**
 * Up to `ctx.optionCount` options, each over venues no earlier option used.
 * Stops at the first option the pool cannot fill.
 */
export async function assembleOptions(
  intent: Intent,
  candidates: readonly Candidate[],
  ctx: AssembleContext,
  signal: AbortSignal,
): Promise<ItineraryOption[]> {
  const pools = poolsByStopType(candidates);
  const used = new Set<string>();
  const options: ItineraryOption[] = [];
  while (options.length < ctx.optionCount) {
    const placed = await buildOption(intent, pools, used, ctx, signal);
    if (placed === null) {
      break;
    }
    placed.forEach((stop) => used.add(stop.candidate.placeId));
    options.push(toOption(placed, intent, ctx.mode, options.length + 1));
  }
  return options;
}
