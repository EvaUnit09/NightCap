import type { RedactionErrorCode } from "../monitoring/redact";
import type { GapReason, StopType } from "../retrieval";
import type { Intent } from "../validation/intent";
import type { ItineraryOption } from "../validation/itinerary";
import type { ValidationErrorCode } from "../validation/validation-error";
import type { EmittedOption } from "./emit-gate";
import type { ModelStage } from "./model-client";

/**
 * The request lifecycle as data. Each stage either hands the next stage a
 * value or ends the request with a typed failure; there is no third path.
 *
 *   redact → parse → retrieve → plan → validate ⇄ repair → emit
 */

/** Why a model call produced nothing usable. */
export type ModelFailureCode =
  /** The client threw: network, HTTP status, missing key. */
  | "model_error"
  | "refusal"
  /** Stopped before `end_turn`, so the JSON may be cut off. */
  | "truncated"
  | "no_json"
  /** JSON that fails the stage's Zod contract. */
  | "schema_invalid";

export type ModelCallOutcome<T> =
  | { readonly kind: "parsed"; readonly value: T; readonly call: ModelCallRecord }
  | { readonly kind: "failed"; readonly code: ModelFailureCode; readonly call: ModelCallRecord | null };

/** One model call, for cost accounting and format compliance in eval. */
export interface ModelCallRecord {
  readonly stage: ModelStage;
  readonly model: string;
  readonly promptVersion: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Undefined when the model has no list price in `src/models/pricing.ts`. */
  readonly costUsd: number | undefined;
  /** Parsed against the stage's Zod contract on this first try. */
  readonly formatValid: boolean;
}

export type RetrievalFailureCode = "no_candidates" | "retrieval_error";

/** The request ends at the first stage that fails. */
export type PipelineFailure =
  | { readonly stage: "redact"; readonly code: RedactionErrorCode }
  | { readonly stage: "parse"; readonly code: ModelFailureCode }
  | { readonly stage: "retrieve"; readonly code: RetrievalFailureCode }
  | { readonly stage: "plan"; readonly code: ModelFailureCode }
  /** Every planned option was dropped. `dropped` on the result says why. */
  | { readonly stage: "validate"; readonly code: "no_valid_options" };

/** A planned option still in the repair loop. Its index is its position in the plan. */
export interface WorkingOption {
  readonly optionIndex: number;
  readonly option: ItineraryOption;
  readonly repairRounds: number;
}

export type DropReason =
  /** Still failing after `getRepairMaxRounds()` repairs. */
  | "repair_exhausted"
  /** Only codes repair cannot fix, such as `travel_service_unavailable`. */
  | "unrepairable"
  /** A stop's place id was not a retrieval candidate at the emit gate. */
  | "invented_venue";

export interface DroppedOption {
  readonly optionIndex: number;
  readonly reason: DropReason;
  readonly repairRounds: number;
  /** Codes from the last validation of this option. */
  readonly lastCodes: readonly ValidationErrorCode[];
}

/** A place id a model returned that this request's retrieval never did. */
export interface InventedPlaceId {
  readonly stage: "plan" | "repair";
  /** 0 for the plan; n for repair round n. */
  readonly round: number;
  readonly optionIndex: number;
  readonly placeId: string;
}

/**
 * What eval reads: the invented-venue rate (from `inventedPlaceIds` against
 * `plannedOptionCount`), format compliance (from `modelCalls`), the repair
 * rate, and cost. It never contains request text, names, or intent strings.
 */
export interface PipelineAudit {
  readonly modelCalls: readonly ModelCallRecord[];
  readonly candidateCount: number;
  readonly plannedOptionCount: number;
  readonly inventedPlaceIds: readonly InventedPlaceId[];
  readonly repairRoundsRun: number;
  readonly totalCostUsd: number;
}

export interface RetrievalGap {
  readonly stopType: StopType;
  readonly reason: GapReason;
}

export type PipelineResult =
  | {
      readonly kind: "completed";
      readonly intent: Intent;
      readonly options: readonly [EmittedOption, ...EmittedOption[]];
      readonly dropped: readonly DroppedOption[];
      /** Non-empty when retrieval was partial. */
      readonly retrievalGaps: readonly RetrievalGap[];
      readonly audit: PipelineAudit;
    }
  | {
      readonly kind: "failed";
      readonly failure: PipelineFailure;
      /** Present once parse succeeded. */
      readonly intent: Intent | null;
      readonly dropped: readonly DroppedOption[];
      readonly retrievalGaps: readonly RetrievalGap[];
      readonly audit: PipelineAudit;
    };
