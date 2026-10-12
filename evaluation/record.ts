import type {
  DroppedOption,
  PipelineAudit,
  PipelineFailure,
  PipelineResult,
  RetrievalGap,
} from "../src/pipeline/lifecycle";
import type { StopType } from "../src/retrieval";
import type { Candidate } from "../src/validation/candidate";
import type { Intent } from "../src/validation/intent";

/**
 * One eval case after it ran: the data shape the scorer reads (build step 19).
 *
 * A record holds ids, counts, and codes only. It never holds the request
 * text, venue names, or the intent's free-text fields (area, tags), so a
 * report can be shared without leaking a query. The case id points back to
 * the frozen case file for the text.
 */
export interface EvalCaseRecord {
  readonly caseId: string;
  readonly outcome: EvalOutcome;
  /** Null until parse succeeded. */
  readonly intent: RecordedIntent | null;
  /** Options the system emitted, in emit order. Empty unless completed. */
  readonly options: readonly RecordedOption[];
  readonly dropped: readonly DroppedOption[];
  readonly retrievalGaps: readonly RetrievalGap[];
  /** The candidate pool this case's retrieval returned. Empty if retrieval never ran or threw. */
  readonly pool: readonly PoolVenue[];
  /**
   * An outside judgement of whether the pool admits at least one fully
   * valid itinerary, from an injected pool oracle (for example the
   * filter-only baseline of build step 20). Null when no oracle ran.
   */
  readonly poolOracle: boolean | null;
  /** Null when the runner threw before the pipeline returned. */
  readonly audit: PipelineAudit | null;
}

export type EvalOutcome =
  | { readonly kind: "completed" }
  | { readonly kind: "failed"; readonly failure: PipelineFailure }
  /** The run threw: an abort, a per-case timeout, or a bug. Scored as an invalid case. */
  | { readonly kind: "error"; readonly message: string };

/**
 * The parsed intent fields eval needs. `budgetUsd` is kept so a later pass
 * can compare it with the case's budget once the per-person vs per-party
 * question in the v1 set is settled (see `score.ts`).
 */
export interface RecordedIntent {
  readonly budgetUsd: number;
  readonly stopTypes: readonly StopType[];
  readonly singleStop: boolean;
}

export interface RecordedOption {
  readonly optionIndex: number;
  readonly repairRounds: number;
  readonly placeIds: readonly string[];
}

export interface PoolVenue {
  readonly placeId: string;
  readonly stopType: StopType;
  readonly reviewCount: number;
}

export function recordedIntent(intent: Intent): RecordedIntent {
  return { budgetUsd: intent.budgetUsd, stopTypes: intent.stopTypes, singleStop: intent.singleStop };
}

export function poolOf(candidates: readonly Candidate[]): PoolVenue[] {
  return candidates.map(({ placeId, stopType, reviewCount }) => ({ placeId, stopType, reviewCount }));
}

export interface PipelineObservation {
  readonly pool: readonly PoolVenue[];
  readonly poolOracle: boolean | null;
}

/** A finished pipeline run as a record. Pure. */
export function recordFromResult(
  caseId: string,
  result: PipelineResult,
  observed: PipelineObservation,
): EvalCaseRecord {
  const intent = result.intent === null ? null : recordedIntent(result.intent);
  const options = result.kind === "completed"
    ? result.options.map((emitted) => ({
        optionIndex: emitted.optionIndex,
        repairRounds: emitted.repairRounds,
        placeIds: emitted.option.stops.map((stop) => stop.placeId),
      }))
    : [];
  return {
    caseId,
    outcome: result.kind === "completed" ? { kind: "completed" } : { kind: "failed", failure: result.failure },
    intent,
    options,
    dropped: result.dropped,
    retrievalGaps: result.retrievalGaps,
    pool: observed.pool,
    poolOracle: observed.poolOracle,
    audit: result.audit,
  };
}

/** A run that threw before the pipeline returned. Pure. */
export function recordFromError(caseId: string, message: string, observed: PipelineObservation): EvalCaseRecord {
  return {
    caseId,
    outcome: { kind: "error", message },
    intent: null,
    options: [],
    dropped: [],
    retrievalGaps: [],
    pool: observed.pool,
    poolOracle: observed.poolOracle,
    audit: null,
  };
}
