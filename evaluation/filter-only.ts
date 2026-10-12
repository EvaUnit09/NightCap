import type { PipelineAudit, PipelineFailure } from "../src/pipeline/lifecycle";
import type { PipelineDeps } from "../src/pipeline";
import { allCandidates } from "../src/retrieval";
import type { Candidate } from "../src/validation/candidate";
import type { TravelMode } from "../src/validation/common";
import type { Intent } from "../src/validation/intent";
import type { TravelCalculator } from "../src/validation/travel";
import { assembleOptions, type AssembleContext } from "./assemble";
import { intentFromCase } from "./case-intent";
import type { EvalCase } from "./cases";
import { judgeOptions } from "./judge";
import { poolOf, recordedIntent, type EvalCaseRecord } from "./record";
import type { CaseRunner, PoolOracle } from "./runner";

/**
 * The filter-only baseline (build step 20): the real retrieval, no model.
 * Intent comes from the case's labelled constraints (`case-intent.ts`);
 * options are the top-ranked candidates per stop type, scheduled and then
 * judged by the real validator. It is also usable as the `PoolOracle`.
 */

export const FILTER_ONLY_SYSTEM = "filter-only";

export type FilterOnlyDeps = Pick<PipelineDeps, "retrieve" | "validate" | "maxLegs"> & {
  /** Times the legs the baseline claims. Production passes the same Routes calculator the validator uses. */
  readonly travel: TravelCalculator;
};

const OPTIONS_MIN = 2;
const OPTIONS_MAX = 3;
/** The oracle has no case to read a mode from; transit reaches furthest, so it is the generous reading of a pool. */
const ORACLE_TRAVEL_MODE: TravelMode = "TRANSIT";

function noModelAudit(candidateCount: number, plannedOptionCount: number): PipelineAudit {
  return {
    modelCalls: [],
    candidateCount,
    plannedOptionCount,
    inventedPlaceIds: [],
    repairRoundsRun: 0,
    totalCostUsd: 0,
  };
}

/** How many options fit under the leg cap at this stop count, between 2 and 3. */
function optionCountFor(intent: Intent, expected: number, maxLegs: number): number {
  const legsPerOption = Math.max(intent.stopTypes.length - 1, 0);
  const wanted = Math.min(Math.max(expected, OPTIONS_MIN), OPTIONS_MAX);
  const fitting = legsPerOption === 0 ? wanted : Math.floor(maxLegs / legsPerOption);
  return Math.max(OPTIONS_MIN, Math.min(wanted, fitting));
}

async function assembleAndJudge(
  deps: FilterOnlyDeps,
  intent: Intent,
  candidates: readonly Candidate[],
  context: Pick<AssembleContext, "mode" | "optionCount">,
  signal: AbortSignal,
) {
  const options = await assembleOptions(intent, candidates, { ...context, travel: deps.travel }, signal);
  const judged = await judgeOptions(deps.validate, intent, candidates, options);
  return { options, judged };
}

function failedRecord(
  evalCase: EvalCase,
  intent: Intent,
  failure: PipelineFailure,
  rest: Pick<EvalCaseRecord, "pool" | "poolOracle" | "audit" | "dropped" | "retrievalGaps">,
): EvalCaseRecord {
  return {
    caseId: evalCase.id,
    outcome: { kind: "failed", failure },
    intent: recordedIntent(intent),
    options: [],
    ...rest,
  };
}

export function filterOnlyCaseRunner(deps: FilterOnlyDeps): CaseRunner {
  return async (evalCase, signal) => {
    const intent = intentFromCase(evalCase);
    const retrieved = await deps.retrieve(intent, signal).then(
      (retrieval) => ({ ok: true as const, retrieval }),
      (error: unknown) => {
        if (signal.aborted) {
          throw error;
        }
        return { ok: false as const };
      },
    );
    const empty = { pool: [], poolOracle: null, dropped: [], retrievalGaps: [], audit: noModelAudit(0, 0) };
    if (!retrieved.ok) {
      return failedRecord(evalCase, intent, { stage: "retrieve", code: "retrieval_error" }, empty);
    }
    const candidates = allCandidates(retrieved.retrieval);
    const retrievalGaps = [...retrieved.retrieval.byStopType].flatMap(([stopType, outcome]) =>
      outcome.kind === "gap" ? [{ stopType, reason: outcome.reason }] : [],
    );
    if (candidates.length === 0) {
      return failedRecord(evalCase, intent, { stage: "retrieve", code: "no_candidates" }, { ...empty, retrievalGaps });
    }

    const { constraints } = evalCase;
    const { options, judged } = await assembleAndJudge(
      deps,
      intent,
      candidates,
      {
        mode: constraints.travel_modes[0],
        optionCount: optionCountFor(intent, constraints.expected_options, deps.maxLegs),
      },
      signal,
    );
    const rest = {
      pool: poolOf(candidates),
      poolOracle: judged.validIndexes.length > 0,
      dropped: judged.dropped,
      retrievalGaps,
      audit: noModelAudit(candidates.length, options.length),
    };
    if (judged.validIndexes.length === 0) {
      return failedRecord(evalCase, intent, { stage: "validate", code: "no_valid_options" }, rest);
    }
    return {
      caseId: evalCase.id,
      outcome: { kind: "completed" },
      intent: recordedIntent(intent),
      options: judged.validIndexes.map((index) => ({
        optionIndex: index,
        repairRounds: 0,
        placeIds: options[index].stops.map((stop) => stop.placeId),
      })),
      ...rest,
    };
  };
}

/**
 * Candidate-recall oracle: the pool admits a valid itinerary when this
 * baseline's greedy assembly of it passes the real validator. A hit is
 * proof; a miss only means the greedy assembly found nothing, not that no
 * itinerary exists, so recall built on it is an upper estimate of misses.
 */
export function filterOnlyPoolOracle(deps: FilterOnlyDeps): PoolOracle {
  return async (intent, candidates, signal) => {
    const { judged } = await assembleAndJudge(
      deps,
      intent,
      candidates,
      { mode: ORACLE_TRAVEL_MODE, optionCount: optionCountFor(intent, OPTIONS_MAX, deps.maxLegs) },
      signal,
    );
    return judged.validIndexes.length > 0;
  };
}
