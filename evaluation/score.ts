import type { ModelStage } from "../src/pipeline/model-client";
import type { PartyBudget } from "./party-budget";
import type { EvalCaseRecord } from "./record";

/**
 * Pure scoring for build step 19: records in, metrics out. No I/O, no clock.
 *
 * Each metric names its numerator and denominator. Unless a metric says
 * otherwise, every case the runner attempted is in the denominator, and a
 * case that failed at any stage or threw counts against it. Definitions
 * come from docs/scope.md "Success Metrics" and §4; where scope is silent
 * the choice is marked CHOICE.
 *
 * Budget: the validator's budget check is the sum of stop totals against
 * the parsed intent's `budgetUsd`, a party total (decision #25). Whether
 * the parse read the right budget is the separate budget-fit metric, scored
 * against the case's whole-party budget (decision #41, `party-budget.ts`).
 */

export interface Ratio {
  readonly numerator: number;
  readonly denominator: number;
  /** numerator / denominator, or null when the denominator is 0. */
  readonly rate: number | null;
}

/** CHOICE: scope says "top-N most-reviewed" without N. */
export const NOVELTY_TOP_N = 3;
/** scope.md: validity rate ≥ 90%. */
export const VALIDITY_TARGET = 0.9;

export type PoolVerdict = "hit" | "miss" | "unknown" | "not_applicable";

export interface CandidateRecall {
  readonly hit: number;
  readonly miss: number;
  readonly unknown: number;
  readonly notApplicable: number;
  /** hit / (hit + miss + unknown): every unknown counted as a miss. */
  readonly lowerBound: Ratio;
  /** (hit + unknown) / (hit + miss + unknown): every unknown counted as a hit. */
  readonly upperBound: Ratio;
}

export interface EvalMetrics {
  readonly caseCount: number;
  /** Case count per outcome: `completed`, `error`, or `<stage>/<code>`. */
  readonly outcomes: Readonly<Record<string, number>>;
  readonly validity: { readonly cases: Ratio; readonly options: Ratio };
  readonly inventedVenue: { readonly cases: Ratio; readonly options: Ratio; readonly inventedIds: number };
  readonly formatCompliance: { readonly overall: Ratio; readonly byStage: Readonly<Record<ModelStage, Ratio>> };
  readonly diversity: {
    readonly distinctVenues: Ratio;
    readonly outsideTopN: Ratio;
    readonly topN: number;
    readonly overlappingResponses: Ratio;
  };
  readonly candidateRecall: CandidateRecall;
  readonly planValidityGivenPool: Ratio;
  readonly budgetFit: Ratio;
  readonly gates: {
    readonly validity: { readonly target: number; readonly pass: boolean };
    readonly inventedVenue: { readonly target: 0; readonly pass: boolean };
  };
}

export function ratio(numerator: number, denominator: number): Ratio {
  return { numerator, denominator, rate: denominator === 0 ? null : numerator / denominator };
}

function countWhere<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  return items.filter(predicate).length;
}

function hasInvention(record: EvalCaseRecord): boolean {
  return (record.audit?.inventedPlaceIds.length ?? 0) > 0;
}

function plannedOptions(record: EvalCaseRecord): number {
  return record.audit?.plannedOptionCount ?? 0;
}

/**
 * A case is valid when the pipeline completed (at least one option was
 * emitted, and every emitted option passed `validateItinerary` and the
 * emit gate: Places-known and OPERATIONAL, open for its slot, total within
 * budget, every leg within the travel cap) AND no model produced an
 * invented place id at any point (scope: an invented id "fails the case",
 * even if repair later replaced it).
 *
 * CHOICE: the unit is the case, not the option, so parse, retrieval, and
 * plan failures count. A completed case that emitted fewer options than
 * planned is still valid here; `validity.options` shows that loss.
 */
export function isValidCase(record: EvalCaseRecord): boolean {
  return record.outcome.kind === "completed" && !hasInvention(record);
}

/**
 * Whether the case's candidate pool admits at least one fully valid
 * itinerary (scope §4 "Candidate recall"), decided in this order:
 *
 *   1. completed → hit: an emitted option is a witness.
 *   2. never reached retrieval (redact or parse failed, or the run threw
 *      without an oracle verdict) → not_applicable.
 *   3. a pool oracle ran → its verdict.
 *   4. retrieval failed, returned nothing, or left a requested stop type
 *      with no candidates (a gap) → miss.
 *   5. otherwise → unknown: the planner failed on a pool nothing has
 *      judged. Without an oracle these stay unknown rather than guessed.
 */
export function poolVerdict(record: EvalCaseRecord): PoolVerdict {
  const { outcome } = record;
  if (outcome.kind === "completed") {
    return "hit";
  }
  if (outcome.kind === "error") {
    return record.poolOracle === null ? "not_applicable" : record.poolOracle ? "hit" : "miss";
  }
  if (outcome.failure.stage === "redact" || outcome.failure.stage === "parse") {
    return "not_applicable";
  }
  if (record.poolOracle !== null) {
    return record.poolOracle ? "hit" : "miss";
  }
  if (outcome.failure.stage === "retrieve" || record.retrievalGaps.length > 0) {
    return "miss";
  }
  return "unknown";
}

function outcomeKey(record: EvalCaseRecord): string {
  const { outcome } = record;
  if (outcome.kind === "failed") {
    return `${outcome.failure.stage}/${outcome.failure.code}`;
  }
  return outcome.kind;
}

function outcomeCounts(records: readonly EvalCaseRecord[]): Record<string, number> {
  return records.reduce<Record<string, number>>((counts, record) => {
    const key = outcomeKey(record);
    return { ...counts, [key]: (counts[key] ?? 0) + 1 };
  }, {});
}

/**
 * Validity.
 * - cases: valid cases (`isValidCase`) / all cases.
 * - options: emitted options / planned options, summed over cases whose
 *   plan parsed. Cases that never produced a plan are not in it.
 */
function scoreValidity(records: readonly EvalCaseRecord[]) {
  const emitted = records.reduce((total, record) => total + record.options.length, 0);
  const planned = records.reduce((total, record) => total + plannedOptions(record), 0);
  return { cases: ratio(countWhere(records, isValidCase), records.length), options: ratio(emitted, planned) };
}

/**
 * Invented-venue rate, from `audit.inventedPlaceIds` (plan and every
 * repair round, recorded before the emit gate).
 * - cases: cases with ≥ 1 invented id / cases whose plan parsed
 *   (`plannedOptionCount > 0`). A plan that failed its schema is not in
 *   the denominator because its ids were never read. The gate is a
 *   numerator of 0.
 * - options: distinct planned options with ≥ 1 invented id / planned options.
 * - inventedIds: every recorded invented id, repeats across rounds included.
 */
function scoreInvented(records: readonly EvalCaseRecord[]) {
  const withPlan = records.filter((record) => plannedOptions(record) > 0);
  const inventedOptions = withPlan.reduce((total, record) => {
    const indexes = new Set(record.audit?.inventedPlaceIds.map((entry) => entry.optionIndex));
    return total + indexes.size;
  }, 0);
  const planned = withPlan.reduce((total, record) => total + plannedOptions(record), 0);
  const inventedIds = records.reduce((total, record) => total + (record.audit?.inventedPlaceIds.length ?? 0), 0);
  return {
    cases: ratio(countWhere(withPlan, hasInvention), withPlan.length),
    options: ratio(inventedOptions, planned),
    inventedIds,
  };
}

const MODEL_STAGES: readonly ModelStage[] = ["parse_intent", "plan_itineraries", "repair_itinerary"];

/**
 * Format compliance: model calls whose output parsed against the stage's
 * Zod contract on that call (`ModelCallRecord.formatValid`) / model calls
 * recorded in the audit. Each call is one first try; there are no
 * retries. A call that threw before returning (network, HTTP status) has
 * no record and is not counted: it is not a format outcome. A refusal or a
 * truncated reply counts as not compliant.
 */
function scoreFormat(records: readonly EvalCaseRecord[]) {
  const calls = records.flatMap((record) => record.audit?.modelCalls ?? []);
  const stageRatio = (stage: ModelStage) => {
    const ofStage = calls.filter((call) => call.stage === stage);
    return ratio(countWhere(ofStage, (call) => call.formatValid), ofStage.length);
  };
  const byStage = Object.fromEntries(MODEL_STAGES.map((stage) => [stage, stageRatio(stage)])) as Record<
    ModelStage,
    Ratio
  >;
  return { overall: ratio(countWhere(calls, (call) => call.formatValid), calls.length), byStage };
}

/** True when the venue ranks outside the top N by review count among same-stop-type venues in its pool. */
function isOutsideTopN(record: EvalCaseRecord, placeId: string, n: number): boolean | null {
  const venue = record.pool.find((entry) => entry.placeId === placeId);
  if (venue === undefined) {
    return null;
  }
  const moreReviewed = countWhere(
    record.pool,
    (entry) => entry.stopType === venue.stopType && entry.reviewCount > venue.reviewCount,
  );
  return moreReviewed + 1 > n;
}

function hasOverlap(record: EvalCaseRecord): boolean {
  const seen = new Set<string>();
  return record.options.some((option) => {
    const unique = new Set(option.placeIds);
    const shared = [...unique].some((placeId) => seen.has(placeId));
    unique.forEach((placeId) => seen.add(placeId));
    return shared;
  });
}

/**
 * Diversity and novelty, over emitted stops only.
 * - distinctVenues: distinct place ids across every emitted stop in the
 *   set / emitted stops.
 * - outsideTopN: emitted stops whose venue ranks below the top N by
 *   review count among the same stop type / emitted stops found in the
 *   case's pool. Ties share the higher rank. CHOICE: "for their category
 *   and area" is read as "same stop type in this request's pool", since
 *   the pool is already one area. It is pool-relative, not citywide.
 * - overlappingResponses: completed cases where a venue appears in two
 *   or more options / completed cases with ≥ 2 options. Target 0.
 */
function scoreDiversity(records: readonly EvalCaseRecord[], topN: number) {
  const stops = records.flatMap((record) =>
    record.options.flatMap((option) => option.placeIds.map((placeId) => ({ record, placeId }))),
  );
  const novelty = stops
    .map(({ record, placeId }) => isOutsideTopN(record, placeId, topN))
    .filter((outside): outside is boolean => outside !== null);
  const multiOption = records.filter((record) => record.options.length >= 2);
  return {
    distinctVenues: ratio(new Set(stops.map((stop) => stop.placeId)).size, stops.length),
    outsideTopN: ratio(countWhere(novelty, (outside) => outside), novelty.length),
    topN,
    overlappingResponses: ratio(countWhere(multiOption, hasOverlap), multiOption.length),
  };
}

/**
 * Candidate recall, scored apart from validity so a retrieval miss is not
 * charged to the planner. See `poolVerdict` for how each case is decided.
 * Denominator: cases that reached retrieval (`not_applicable` excluded).
 * Reported as bounds because cases nobody judged stay `unknown`; the
 * bounds meet once a pool oracle decides every case.
 */
function scoreRecall(verdicts: readonly PoolVerdict[]): CandidateRecall {
  const count = (verdict: PoolVerdict) => countWhere(verdicts, (v) => v === verdict);
  const [hit, miss, unknown] = [count("hit"), count("miss"), count("unknown")];
  const applicable = hit + miss + unknown;
  return {
    hit,
    miss,
    unknown,
    notApplicable: count("not_applicable"),
    lowerBound: ratio(hit, applicable),
    upperBound: ratio(hit + unknown, applicable),
  };
}

/**
 * Plan validity given a good pool (scope §4): valid cases / cases whose
 * pool verdict is hit or unknown. Proven retrieval misses and cases that
 * never reached retrieval are left out. Unknown cases stay in, so a
 * failure on an unjudged pool is charged to the planner until an oracle
 * says the pool could not work.
 */
function scorePlanGivenPool(records: readonly EvalCaseRecord[], verdicts: readonly PoolVerdict[]): Ratio {
  const eligible = records.filter((_, index) => verdicts[index] === "hit" || verdicts[index] === "unknown");
  return ratio(countWhere(eligible, isValidCase), eligible.length);
}

/**
 * Budget fit: did the parse read the party budget right?
 * - numerator: cases whose parsed `intent.budgetUsd` lies in the case's
 *   whole-party range, inclusive: `min <= budgetUsd <= max`.
 * - denominator: cases whose intent a model parsed (`intent.source ===
 *   "model"`) and whose id has an entry in `partyBudgets`. A case that never
 *   parsed is charged by validity, not here; a case with no known budget
 *   cannot be judged. Baselines record the case label's own budget, so they
 *   have an empty denominator and report n/a.
 * The range is the frozen label's own tolerance band, not the stated cap.
 * Most bands run above the cap (nc-005 "Under $40" has band 20-50; nc-010
 * "under $90" has 50-100), so a parse slightly over the cap still counts.
 */
function scoreBudgetFit(records: readonly EvalCaseRecord[], partyBudgets: ReadonlyMap<string, PartyBudget>): Ratio {
  const judged = records.flatMap((record) => {
    const budget = partyBudgets.get(record.caseId);
    return record.intent?.source !== "model" || budget === undefined ? [] : [{ parsed: record.intent.budgetUsd, budget }];
  });
  return ratio(countWhere(judged, ({ parsed, budget }) => parsed >= budget.min && parsed <= budget.max), judged.length);
}

export interface ScoreOptions {
  readonly topN?: number;
  /** Whole-party budget per case id (`partyBudgetsById`). Omitted: budget fit has an empty denominator. */
  readonly partyBudgets?: ReadonlyMap<string, PartyBudget>;
}

export function scoreRecords(records: readonly EvalCaseRecord[], options: ScoreOptions = {}): EvalMetrics {
  const verdicts = records.map(poolVerdict);
  const validity = scoreValidity(records);
  const inventedVenue = scoreInvented(records);
  return {
    caseCount: records.length,
    outcomes: outcomeCounts(records),
    validity,
    inventedVenue,
    formatCompliance: scoreFormat(records),
    diversity: scoreDiversity(records, options.topN ?? NOVELTY_TOP_N),
    candidateRecall: scoreRecall(verdicts),
    planValidityGivenPool: scorePlanGivenPool(records, verdicts),
    budgetFit: scoreBudgetFit(records, options.partyBudgets ?? new Map()),
    gates: {
      validity: { target: VALIDITY_TARGET, pass: (validity.cases.rate ?? 0) >= VALIDITY_TARGET },
      inventedVenue: { target: 0, pass: inventedVenue.cases.numerator === 0 },
    },
  };
}
