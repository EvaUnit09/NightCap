import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { EvalCaseRecord, PoolVenue, RecordedOption } from "../../evaluation/record";
import { isValidCase, poolVerdict, ratio, scoreRecords } from "../../evaluation/score";
import type { InventedPlaceId, ModelCallRecord, PipelineAudit } from "../../src/pipeline/lifecycle";
import type { ModelStage } from "../../src/pipeline/model-client";

function call(stage: ModelStage, formatValid: boolean): ModelCallRecord {
  return { stage, model: "m", promptVersion: "v1", inputTokens: 1, outputTokens: 1, costUsd: 0, formatValid };
}

function audit(overrides: Partial<PipelineAudit> = {}): PipelineAudit {
  return {
    modelCalls: [call("parse_intent", true), call("plan_itineraries", true)],
    candidateCount: 4,
    plannedOptionCount: 2,
    inventedPlaceIds: [],
    repairRoundsRun: 0,
    totalCostUsd: 0,
    ...overrides,
  };
}

const POOL: readonly PoolVenue[] = [
  { placeId: "bar-famous", stopType: "drinks", reviewCount: 9_000 },
  { placeId: "bar-2", stopType: "drinks", reviewCount: 800 },
  { placeId: "bar-3", stopType: "drinks", reviewCount: 500 },
  { placeId: "bar-quiet", stopType: "drinks", reviewCount: 40 },
  { placeId: "din-1", stopType: "dinner", reviewCount: 3_000 },
  { placeId: "din-2", stopType: "dinner", reviewCount: 30 },
];

function opt(optionIndex: number, ...placeIds: string[]): RecordedOption {
  return { optionIndex, repairRounds: 0, placeIds };
}

const INTENT = { budgetUsd: 150, stopTypes: ["drinks", "dinner"] as const, singleStop: false };

function completed(caseId: string, options: RecordedOption[], overrides: Partial<EvalCaseRecord> = {}): EvalCaseRecord {
  return {
    caseId,
    outcome: { kind: "completed" },
    intent: { ...INTENT, stopTypes: [...INTENT.stopTypes] },
    options,
    dropped: [],
    retrievalGaps: [],
    pool: POOL,
    poolOracle: null,
    audit: audit(),
    ...overrides,
  };
}

function failed(
  caseId: string,
  failure: Extract<EvalCaseRecord["outcome"], { kind: "failed" }>["failure"],
  overrides: Partial<EvalCaseRecord> = {},
): EvalCaseRecord {
  return {
    caseId,
    outcome: { kind: "failed", failure },
    intent: null,
    options: [],
    dropped: [],
    retrievalGaps: [],
    pool: [],
    poolOracle: null,
    audit: audit({ plannedOptionCount: 0, modelCalls: [call("parse_intent", false)] }),
    ...overrides,
  };
}

function errored(caseId: string): EvalCaseRecord {
  return { ...failed(caseId, { stage: "parse", code: "model_error" }), outcome: { kind: "error", message: "boom" }, audit: null };
}

const invented = (optionIndex: number, round = 0): InventedPlaceId => ({
  stage: round === 0 ? "plan" : "repair",
  round,
  optionIndex,
  placeId: "ChIJmade_up",
});

describe("ratio", () => {
  it("is null over an empty denominator", () => {
    assert.deepEqual(ratio(0, 0), { numerator: 0, denominator: 0, rate: null });
    assert.equal(ratio(1, 4).rate, 0.25);
  });
});

describe("isValidCase", () => {
  it("is valid only when completed with no invented id at any stage", () => {
    assert.equal(isValidCase(completed("a", [opt(0, "bar-2", "din-1")])), true);
    const repairedInvention = completed("b", [opt(0, "bar-2", "din-1")], {
      audit: audit({ inventedPlaceIds: [invented(1, 1)] }),
    });
    assert.equal(isValidCase(repairedInvention), false, "an invented id fails the case even after repair");
    assert.equal(isValidCase(failed("c", { stage: "validate", code: "no_valid_options" })), false);
    assert.equal(isValidCase(errored("d")), false);
  });
});

describe("poolVerdict", () => {
  const planFailed = { stage: "plan", code: "schema_invalid" } as const;

  it("a completed case is a hit: its emitted option is a witness", () => {
    assert.equal(poolVerdict(completed("a", [opt(0, "bar-2", "din-1")])), "hit");
  });

  it("redact and parse failures never reached retrieval", () => {
    assert.equal(poolVerdict(failed("a", { stage: "parse", code: "schema_invalid" })), "not_applicable");
    assert.equal(poolVerdict(failed("b", { stage: "redact", code: "too_long" })), "not_applicable");
    assert.equal(poolVerdict(errored("c")), "not_applicable");
  });

  it("a retrieval failure or a gap is a miss", () => {
    assert.equal(poolVerdict(failed("a", { stage: "retrieve", code: "no_candidates" })), "miss");
    const gap = failed("b", planFailed, { retrievalGaps: [{ stopType: "dessert", reason: "no_matches" }] });
    assert.equal(poolVerdict(gap), "miss");
  });

  it("a planner failure on an unjudged full pool is unknown, and an oracle decides it", () => {
    assert.equal(poolVerdict(failed("a", planFailed, { pool: POOL })), "unknown");
    assert.equal(poolVerdict(failed("b", planFailed, { pool: POOL, poolOracle: true })), "hit");
    assert.equal(poolVerdict(failed("c", planFailed, { pool: POOL, poolOracle: false })), "miss");
    const gapButOracleSaysYes = failed("d", planFailed, {
      retrievalGaps: [{ stopType: "dessert", reason: "no_matches" }],
      poolOracle: true,
    });
    assert.equal(poolVerdict(gapButOracleSaysYes), "hit", "the oracle outranks the gap heuristic");
  });
});

describe("scoreRecords", () => {
  // 5 cases: 2 valid, 1 completed with a repaired invention, 1 retrieval miss, 1 plan failure on a full pool.
  const records: EvalCaseRecord[] = [
    completed("nc-001", [opt(0, "bar-quiet", "din-2"), opt(1, "bar-3", "din-1")]),
    completed("nc-002", [opt(0, "bar-famous", "din-1")], {
      audit: audit({ plannedOptionCount: 2 }),
      dropped: [{ optionIndex: 1, reason: "repair_exhausted", repairRounds: 2, lastCodes: ["closed"] }],
    }),
    completed("nc-003", [opt(0, "bar-2", "din-2"), opt(1, "bar-2", "din-1")], {
      audit: audit({
        inventedPlaceIds: [invented(1, 0), invented(1, 1)],
        repairRoundsRun: 1,
        modelCalls: [call("parse_intent", true), call("plan_itineraries", true), call("repair_itinerary", false)],
      }),
    }),
    failed("nc-004", { stage: "retrieve", code: "no_candidates" }, { audit: audit({ plannedOptionCount: 0, modelCalls: [call("parse_intent", true)] }) }),
    failed("nc-005", { stage: "plan", code: "schema_invalid" }, {
      pool: POOL,
      audit: audit({ plannedOptionCount: 0, modelCalls: [call("parse_intent", true), call("plan_itineraries", false)] }),
    }),
  ];
  const metrics = scoreRecords(records);

  it("counts every attempted case in the validity denominator", () => {
    assert.equal(metrics.caseCount, 5);
    assert.deepEqual(metrics.validity.cases, ratio(2, 5));
    // Emitted 2 + 1 + 2 over planned 2 + 2 + 2; failed cases planned nothing.
    assert.deepEqual(metrics.validity.options, ratio(5, 6));
    assert.equal(metrics.gates.validity.pass, false);
  });

  it("scores invented venues over cases whose plan parsed, and fails the gate on any", () => {
    assert.deepEqual(metrics.inventedVenue.cases, ratio(1, 3));
    assert.deepEqual(metrics.inventedVenue.options, ratio(1, 6), "two rounds on one option count once");
    assert.equal(metrics.inventedVenue.inventedIds, 2);
    assert.equal(metrics.gates.inventedVenue.pass, false);
  });

  it("scores format compliance over recorded calls, per stage", () => {
    // parse: 5 of 5; plan: 3 of 4; repair: 0 of 1.
    assert.deepEqual(metrics.formatCompliance.byStage.parse_intent, ratio(5, 5));
    assert.deepEqual(metrics.formatCompliance.byStage.plan_itineraries, ratio(3, 4));
    assert.deepEqual(metrics.formatCompliance.byStage.repair_itinerary, ratio(0, 1));
    assert.deepEqual(metrics.formatCompliance.overall, ratio(8, 10));
  });

  it("scores diversity over emitted stops", () => {
    // Stops: bar-quiet din-2 bar-3 din-1 | bar-famous din-1 | bar-2 din-2 bar-2 din-1 → 10 stops, 6 distinct.
    assert.deepEqual(metrics.diversity.distinctVenues, ratio(6, 10));
    // Top 3 drinks by reviews: bar-famous, bar-2, bar-3. Dinner has 2 venues, so none is outside the top 3.
    assert.deepEqual(metrics.diversity.outsideTopN, ratio(1, 10));
    assert.equal(metrics.diversity.topN, 3);
    // nc-003 reuses bar-2 across its options; nc-002 has one option and is not in the denominator.
    assert.deepEqual(metrics.diversity.overlappingResponses, ratio(1, 2));
  });

  it("reports candidate recall as bounds and keeps retrieval misses out of plan validity", () => {
    assert.deepEqual(
      { hit: metrics.candidateRecall.hit, miss: metrics.candidateRecall.miss, unknown: metrics.candidateRecall.unknown },
      { hit: 3, miss: 1, unknown: 1 },
    );
    assert.equal(metrics.candidateRecall.notApplicable, 0);
    assert.deepEqual(metrics.candidateRecall.lowerBound, ratio(3, 5));
    assert.deepEqual(metrics.candidateRecall.upperBound, ratio(4, 5));
    // nc-004 (miss) is excluded; nc-001..003 (hit) and nc-005 (unknown) remain.
    assert.deepEqual(metrics.planValidityGivenPool, ratio(2, 4));
  });

  it("tallies outcomes by stage and code", () => {
    assert.deepEqual(metrics.outcomes, { completed: 3, "retrieve/no_candidates": 1, "plan/schema_invalid": 1 });
  });

  it("uses a custom top N", () => {
    assert.deepEqual(scoreRecords(records, { topN: 1 }).diversity.outsideTopN, ratio(6, 10));
  });

  it("passes both gates on a clean set and leaves empty ratios null", () => {
    const clean = Array.from({ length: 10 }, (_, i) => completed(`nc-${i}`, [opt(0, `elsewhere-bar-${i}`), opt(1, `elsewhere-din-${i}`)]));
    const scored = scoreRecords(clean);
    assert.equal(scored.gates.validity.pass, true);
    assert.equal(scored.gates.inventedVenue.pass, true);
    assert.equal(scored.formatCompliance.byStage.repair_itinerary.rate, null);
    assert.deepEqual(scored.diversity.outsideTopN, ratio(0, 0), "venues missing from the pool are not scored for novelty");
  });

  it("scores an empty run without dividing by zero", () => {
    const empty = scoreRecords([]);
    assert.equal(empty.validity.cases.rate, null);
    assert.equal(empty.gates.validity.pass, false);
    assert.equal(empty.gates.inventedVenue.pass, true);
  });
});
