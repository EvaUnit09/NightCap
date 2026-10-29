import { admitOption, type EmittedOption } from "../pipeline/emit-gate";
import type { DroppedOption, ModelCallRecord, WorkingOption } from "../pipeline/lifecycle";
import type { ModelClient } from "../pipeline/model-client";
import type { StopType } from "../retrieval";
import type { Candidate } from "../validation/candidate";
import type { TravelMode } from "../validation/common";
import { DEFAULT_TRAVEL_CAP_MINUTES } from "../validation/defaults";
import type { Intent } from "../validation/intent";
import type { ItineraryOption } from "../validation/itinerary";
import { ITINERARY_OPTIONS_MAX, ITINERARY_OPTIONS_MIN, allowedShapes } from "../validation/itinerary";
import {
  MS_PER_MINUTE,
  STOP_MINUTES,
  firstOpenStart,
  iso,
  toItineraryOption,
  type ScheduledStop,
} from "../validation/schedule";
import type { TravelCalculator } from "../validation/travel";
import type { ValidationError } from "../validation/validation-error";
import type { ValidatorInput } from "../validation/validator";

/**
 * Assembler-first planner (Option C). Venue choice is a greedy scored walk
 * over this request's pool. Theme/why lines are templates on the experiment
 * path so invented place ids stay impossible by construction.
 */

declare const pooled: unique symbol;
/** Minted only by `indexPool`. The scorer cannot spell a new Google id. */
type PooledPlaceId = string & { readonly [pooled]: "PooledPlaceId" };

interface PooledCandidate {
  readonly placeId: PooledPlaceId;
  readonly rank: number;
  readonly source: Candidate;
}

interface Pool {
  readonly byType: ReadonlyMap<StopType, readonly PooledCandidate[]>;
  readonly byId: ReadonlyMap<PooledPlaceId, PooledCandidate>;
}

export interface PlanFromPoolInput {
  readonly intent: Intent;
  readonly candidates: readonly Candidate[];
  readonly models: ModelClient;
  readonly travel: TravelCalculator;
  readonly validate: (
    input: ValidatorInput,
    travel: TravelCalculator,
  ) => Promise<readonly ValidationError[]>;
  readonly maxLegs: number;
  readonly narratePromptVersion: string;
  readonly signal?: AbortSignal;
}

export type PlanFromPoolResult =
  | {
      readonly kind: "ready";
      readonly emitted: readonly [EmittedOption, ...EmittedOption[]];
      readonly dropped: readonly DroppedOption[];
      readonly narration: "model" | "template";
      readonly modelCalls: readonly ModelCallRecord[];
      readonly plannedOptionCount: number;
    }
  | {
      readonly kind: "none";
      readonly dropped: readonly DroppedOption[];
      readonly modelCalls: readonly ModelCallRecord[];
      readonly plannedOptionCount: number;
    };

function indexPool(candidates: readonly Candidate[]): Pool {
  const byType = new Map<StopType, PooledCandidate[]>();
  const byId = new Map<PooledPlaceId, PooledCandidate>();
  for (const source of candidates) {
    const placeId = source.placeId as PooledPlaceId;
    if (byId.has(placeId)) {
      continue;
    }
    const rank = (byType.get(source.stopType) ?? []).length;
    const pooledCandidate: PooledCandidate = { placeId, rank, source };
    byId.set(placeId, pooledCandidate);
    byType.set(source.stopType, [...(byType.get(source.stopType) ?? []), pooledCandidate]);
  }
  return { byType, byId };
}

/** Prefer longer stops, then more options. Counts are identical across options. */
function chooseShape(intent: Intent, maxLegs: number): { readonly optionCount: number; readonly stopCount: number } | null {
  if (intent.singleStop) {
    return { optionCount: ITINERARY_OPTIONS_MIN, stopCount: 1 };
  }
  const parsed = allowedShapes(maxLegs)
    .map((label) => label.split("+").map(Number))
    .filter((counts) => counts.length >= ITINERARY_OPTIONS_MIN && counts.every((n) => Number.isFinite(n)))
    .filter((counts) => counts.every((stops) => stops <= intent.stopTypes.length));
  if (parsed.length === 0) {
    return null;
  }
  parsed.sort((a, b) => {
    const maxA = Math.max(...a);
    const maxB = Math.max(...b);
    return maxB - maxA || b.length - a.length;
  });
  const best = parsed[0]!;
  return { optionCount: best.length, stopCount: best[0]! };
}

function chooseMode(intent: Intent): TravelMode {
  const vibe = intent.vibeTags.join(" ").toLowerCase();
  if (/\b(bike|bicycle)\b/.test(vibe)) {
    return "BICYCLE";
  }
  return "WALK";
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

async function placeNext(
  travel: TravelCalculator,
  mode: TravelMode,
  window: { readonly startMs: number; readonly endMs: number },
  previous: ScheduledStop | undefined,
  pool: readonly PooledCandidate[],
  used: ReadonlySet<PooledPlaceId>,
  signal: AbortSignal | undefined,
): Promise<ScheduledStop | null> {
  for (const entry of pool) {
    if (used.has(entry.placeId)) {
      continue;
    }
    const leg = previous === undefined ? 0 : await hopMinutes(travel, mode, previous, entry.source, signal);
    if (leg === null) {
      continue;
    }
    if (previous !== undefined && leg > DEFAULT_TRAVEL_CAP_MINUTES) {
      continue;
    }
    const notBeforeMs = previous === undefined ? window.startMs : previous.endMs + leg * MS_PER_MINUTE;
    const startMs = firstOpenStart(entry.source, notBeforeMs, window.endMs);
    if (startMs === null) {
      continue;
    }
    return {
      candidate: entry.source,
      startMs,
      endMs: startMs + STOP_MINUTES[entry.source.stopType] * MS_PER_MINUTE,
      legMinutes: leg,
    };
  }
  return null;
}

async function buildOption(
  intent: Intent,
  pool: Pool,
  travel: TravelCalculator,
  mode: TravelMode,
  stopCount: number,
  used: ReadonlySet<PooledPlaceId>,
  signal: AbortSignal | undefined,
): Promise<readonly ScheduledStop[] | null> {
  const window = { startMs: Date.parse(intent.window.start), endMs: Date.parse(intent.window.end) };
  const stopTypes = intent.stopTypes.slice(0, stopCount);
  const placed: ScheduledStop[] = [];
  for (const stopType of stopTypes) {
    const next = await placeNext(travel, mode, window, placed.at(-1), pool.byType.get(stopType) ?? [], used, signal);
    if (next === null) {
      return null;
    }
    placed.push(next);
  }
  return placed;
}

function templateTheme(intent: Intent, optionNumber: number): string {
  return `Assembled ${intent.stopTypes.join(" → ")} (${optionNumber})`;
}

function templateWhys(placed: readonly ScheduledStop[]): string[] {
  return placed.map((stop) => `Pooled ${stop.candidate.stopType}: ${stop.candidate.name}`);
}

/**
 * Build admitted itinerary options from the retrieval pool without a plan model.
 * Narration is template-only on this experiment path (architecture gate allows it).
 */
export async function planFromPool(input: PlanFromPoolInput): Promise<PlanFromPoolResult> {
  void input.models;
  void input.narratePromptVersion;
  const pool = indexPool(input.candidates);
  const shape = chooseShape(input.intent, input.maxLegs);
  if (shape === null) {
    return { kind: "none", dropped: [], modelCalls: [], plannedOptionCount: 0 };
  }

  const mode = chooseMode(input.intent);
  const used = new Set<PooledPlaceId>();
  const options: ItineraryOption[] = [];
  const optionCap = Math.min(shape.optionCount, ITINERARY_OPTIONS_MAX);

  for (let i = 0; i < optionCap; i++) {
    const placed = await buildOption(
      input.intent,
      pool,
      input.travel,
      mode,
      shape.stopCount,
      used,
      input.signal,
    );
    if (placed === null) {
      break;
    }
    for (const stop of placed) {
      used.add(stop.candidate.placeId as PooledPlaceId);
    }
    options.push(
      toItineraryOption(
        placed,
        input.intent,
        mode,
        templateTheme(input.intent, i + 1),
        templateWhys(placed),
      ),
    );
  }

  const plannedOptionCount = options.length;
  if (options.length < ITINERARY_OPTIONS_MIN) {
    return { kind: "none", dropped: [], modelCalls: [], plannedOptionCount };
  }

  const errors = await input.validate(
    {
      intent: input.intent,
      candidates: input.candidates,
      itinerary: { singleStop: input.intent.singleStop, options },
    },
    input.travel,
  );

  const failingIndexes = new Set(
    errors.map((error) => error.optionIndex).filter((index): index is number => index !== undefined),
  );
  const survivors = options.filter((_, index) => !failingIndexes.has(index));
  if (survivors.length < ITINERARY_OPTIONS_MIN && errors.length > 0) {
    // Whole-set format failures have no optionIndex; drop everything.
    const onlyGlobal = errors.every((error) => error.optionIndex === undefined);
    if (onlyGlobal || survivors.length === 0) {
      return { kind: "none", dropped: [], modelCalls: [], plannedOptionCount };
    }
  }

  const working: WorkingOption[] = (survivors.length >= ITINERARY_OPTIONS_MIN ? survivors : options).map(
    (option, optionIndex) => ({ optionIndex, option, repairRounds: 0 }),
  );

  const candidateIds = new Set(input.candidates.map((candidate) => candidate.placeId));
  const emitted: EmittedOption[] = [];
  const dropped: DroppedOption[] = [];
  for (const row of working) {
    const admitted = admitOption(row, candidateIds);
    if (admitted.kind === "admitted") {
      emitted.push(admitted.option);
    } else {
      dropped.push({
        optionIndex: row.optionIndex,
        reason: "invented_venue",
        repairRounds: 0,
        lastCodes: ["invented_venue"],
      });
    }
  }

  const [first, ...rest] = emitted;
  if (first === undefined) {
    return { kind: "none", dropped, modelCalls: [], plannedOptionCount };
  }
  return {
    kind: "ready",
    emitted: [first, ...rest],
    dropped,
    narration: "template",
    modelCalls: [],
    plannedOptionCount,
  };
}
