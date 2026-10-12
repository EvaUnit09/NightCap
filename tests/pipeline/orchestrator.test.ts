import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { resetConfig } from "../../src/models";
import { runPipeline, type PipelineResult } from "../../src/pipeline";
import { loadPlacesFixture } from "../retrieval/places-fixtures";
import {
  INTENT,
  OPTION_A,
  OPTION_B,
  REQUEST_TEXT,
  fakeModels,
  harness,
  option,
  spanNames,
  spansNamed,
} from "./orchestrator-harness";

function completed(result: PipelineResult) {
  assert.equal(result.kind, "completed", JSON.stringify(result.kind === "failed" ? result.failure : null));
  return result as Extract<PipelineResult, { kind: "completed" }>;
}

function failedAt(result: PipelineResult, stage: string, code: string) {
  assert.equal(result.kind, "failed");
  const failed = result as Extract<PipelineResult, { kind: "failed" }>;
  assert.deepEqual(failed.failure, { stage, code });
  return failed;
}

const plan = (...options: unknown[]) => ({ json: { options } });

describe("runPipeline", () => {
  beforeEach(() => {
    resetConfig();
    delete process.env.REPAIR_MAX_ROUNDS;
  });

  it("happy path: parse, retrieve, plan, validate once, and emit both options", async () => {
    const models = fakeModels({ parse_intent: [{ json: INTENT }], plan_itineraries: [plan(OPTION_A, OPTION_B)] });
    const h = harness({ models });

    const result = completed(await runPipeline({ text: REQUEST_TEXT }, h.deps));

    assert.deepEqual(result.options.map((emitted) => emitted.option), [OPTION_A, OPTION_B]);
    assert.deepEqual(result.options.map((emitted) => emitted.repairRounds), [0, 0]);
    assert.deepEqual(result.dropped, []);
    assert.deepEqual(result.retrievalGaps, []);
    assert.deepEqual(result.intent, INTENT);
    assert.equal(h.validations(), 1);
    assert.deepEqual(models.requests().map((request) => request.stage), ["parse_intent", "plan_itineraries"]);
    assert.equal(result.audit.plannedOptionCount, 2);
    assert.deepEqual(result.audit.inventedPlaceIds, []);
    assert.equal(result.audit.candidateCount, 8);
    assert.deepEqual(result.audit.modelCalls.map((call) => [call.stage, call.model, call.formatValid]), [
      ["parse_intent", "claude-haiku-4-5", true],
      ["plan_itineraries", "claude-sonnet-5", true],
    ]);
    // Haiku 4.5 at $1/$5 and Sonnet 5 at $2/$10 per MTok, 1000 in / 200 out each.
    assert.ok(Math.abs(result.audit.totalCostUsd - (0.002 + 0.004)) < 1e-12);
  });

  it("the parse call gets the redacted request inside <user_text>, and the planner sees only candidates", async () => {
    const models = fakeModels({ parse_intent: [{ json: INTENT }], plan_itineraries: [plan(OPTION_A, OPTION_B)] });
    const h = harness({ models });

    await runPipeline({ text: "Dinner with Sarah near Union Square, email jane@example.com" }, h.deps);

    const [parse] = models.requestsFor("parse_intent");
    assert.match(parse.user, /^<user_text>\n[\s\S]*\n<\/user_text>$/);
    assert.doesNotMatch(parse.user, /Sarah|jane@example\.com/);
    assert.match(parse.system, /# Parse Intent/);
    const [planCall] = models.requestsFor("plan_itineraries");
    for (const id of ["ChIJbar0", "ChIJdin3"]) assert.ok(planCall.user.includes(id));
  });

  it("repairs only the failing stop and emits the repaired option", async () => {
    const broken = option("Lively bar and trattoria", ["ChIJbar1", "Employes Only"], ["ChIJdin1", "I Sodi"]);
    const repaired = {
      ...OPTION_B,
      stops: [OPTION_B.stops[0], { ...OPTION_B.stops[1], why: "The model rewrote a passing stop" }],
    };
    const models = fakeModels({
      parse_intent: [{ json: INTENT }],
      plan_itineraries: [plan(OPTION_A, broken)],
      repair_itinerary: [{ json: repaired }],
    });
    const h = harness({ models });

    const result = completed(await runPipeline({ text: REQUEST_TEXT }, h.deps));

    assert.deepEqual(result.options.map((emitted) => [emitted.optionIndex, emitted.repairRounds]), [
      [0, 0],
      [1, 1],
    ]);
    // The name was fixed; the passing dinner stop kept its original why.
    assert.deepEqual(result.options[1].option, OPTION_B);
    assert.equal(models.requestsFor("repair_itinerary").length, 1);
    assert.match(models.requestsFor("repair_itinerary")[0].user, /name_mismatch/);
    assert.equal(h.validations(), 2);
    assert.equal(result.audit.repairRoundsRun, 1);
    const [repairSpan] = spansNamed(h.exporter, "repair");
    assert.equal(repairSpan.attributes.outcome_codes, "name_mismatch");
    assert.equal(repairSpan.attributes.prompt_name, "repair_itinerary");
  });

  it("drops an option still failing after getRepairMaxRounds() repairs and emits the rest", async () => {
    const closedLate = {
      ...OPTION_B,
      stops: [OPTION_B.stops[0], { ...OPTION_B.stops[1], start: "2026-10-17T03:00:00-04:00", end: "2026-10-17T04:00:00-04:00" }],
    };
    const models = fakeModels({
      parse_intent: [{ json: INTENT }],
      plan_itineraries: [plan(OPTION_A, closedLate)],
      repair_itinerary: [{ json: closedLate }, { json: closedLate }],
    });
    const h = harness({ models });

    const result = completed(await runPipeline({ text: REQUEST_TEXT }, h.deps));

    assert.deepEqual(result.options.map((emitted) => emitted.optionIndex), [0]);
    assert.equal(result.dropped.length, 1);
    assert.equal(result.dropped[0].optionIndex, 1);
    assert.equal(result.dropped[0].reason, "repair_exhausted");
    assert.equal(result.dropped[0].repairRounds, 2);
    assert.ok(result.dropped[0].lastCodes.includes("closed"));
    assert.equal(models.requestsFor("repair_itinerary").length, 2);
    assert.equal(h.validations(), 3);
  });

  it("REPAIR_MAX_ROUNDS=1 stops after one repair", async () => {
    process.env.REPAIR_MAX_ROUNDS = "1";
    resetConfig();
    const broken = option("Lively bar and trattoria", ["ChIJbar1", "Employes Only"], ["ChIJdin1", "I Sodi"]);
    const models = fakeModels({
      parse_intent: [{ json: INTENT }],
      plan_itineraries: [plan(OPTION_A, broken)],
      repair_itinerary: [{ json: broken }],
    });

    const result = completed(await runPipeline({ text: REQUEST_TEXT }, harness({ models }).deps));

    assert.deepEqual(result.dropped.map((dropped) => [dropped.reason, dropped.repairRounds]), [["repair_exhausted", 1]]);
    assert.equal(models.requestsFor("repair_itinerary").length, 1);
  });

  it("never emits an invented place id, and the audit counts every one the models produced", async () => {
    const invented = option("Made-up night", ["ChIJbar1", "Employees Only"], ["ChIJnot_a_candidate", "Imaginary Bistro"]);
    const models = fakeModels({
      parse_intent: [{ json: INTENT }],
      plan_itineraries: [plan(OPTION_A, invented)],
      repair_itinerary: [{ json: invented }, { json: invented }],
    });
    const h = harness({ models });

    const result = completed(await runPipeline({ text: REQUEST_TEXT }, h.deps));

    const emittedIds = result.options.flatMap((emitted) => emitted.option.stops.map((s) => s.placeId));
    assert.ok(!emittedIds.includes("ChIJnot_a_candidate"));
    assert.deepEqual(result.dropped.map((dropped) => [dropped.optionIndex, dropped.reason]), [[1, "repair_exhausted"]]);
    assert.ok(result.dropped[0].lastCodes.includes("invented_venue"));
    assert.deepEqual(
      result.audit.inventedPlaceIds.map((entry) => [entry.stage, entry.round, entry.optionIndex, entry.placeId]),
      [
        ["plan", 0, 1, "ChIJnot_a_candidate"],
        ["repair", 1, 1, "ChIJnot_a_candidate"],
        ["repair", 2, 1, "ChIJnot_a_candidate"],
      ],
    );
    const validateCodes = spansNamed(h.exporter, "validate").map((span) => span.attributes.outcome_codes);
    assert.ok(validateCodes.every((codes) => String(codes).includes("invented_venue")));
  });

  it("the emit gate refuses an unknown id even when the validator passes it", async () => {
    const invented = option("Made-up night", ["ChIJbar1", "Employees Only"], ["ChIJnot_a_candidate", "Imaginary Bistro"]);
    const models = fakeModels({ parse_intent: [{ json: INTENT }], plan_itineraries: [plan(OPTION_A, invented)] });
    const h = harness({ models, validate: async () => [] });

    const result = completed(await runPipeline({ text: REQUEST_TEXT }, h.deps));

    assert.deepEqual(result.options.map((emitted) => emitted.optionIndex), [0]);
    assert.deepEqual(result.dropped, [
      { optionIndex: 1, reason: "invented_venue", repairRounds: 0, lastCodes: ["invented_venue"] },
    ]);
  });

  it("fails at validate when every option is dropped", async () => {
    const invented = option("Made-up night", ["ChIJbar1", "Employees Only"], ["ChIJnot_a_candidate", "Imaginary Bistro"]);
    const models = fakeModels({ parse_intent: [{ json: INTENT }], plan_itineraries: [plan(OPTION_A, invented)] });
    const h = harness({ models, validate: async () => [
      { code: "travel_service_unavailable", message: "Routes is down", optionIndex: 0, stopIndex: 0 },
      { code: "travel_service_unavailable", message: "Routes is down", optionIndex: 1, stopIndex: 0 },
    ] });

    const result = failedAt(await runPipeline({ text: REQUEST_TEXT }, h.deps), "validate", "no_valid_options");

    assert.deepEqual(result.dropped.map((dropped) => dropped.reason), ["unrepairable", "unrepairable"]);
    assert.equal(models.requestsFor("repair_itinerary").length, 0, "unrepairable codes are not sent to repair");
  });

  it("a parse reply that is not JSON ends the request before retrieval", async () => {
    const models = fakeModels({ parse_intent: [{ text: "Sure! Here is a plan for your night." }] });
    const h = harness({ models });

    const result = failedAt(await runPipeline({ text: REQUEST_TEXT }, h.deps), "parse", "no_json");

    assert.equal(result.intent, null);
    assert.equal(h.places.fetches(), 0);
    assert.deepEqual(result.audit.modelCalls.map((call) => call.formatValid), [false]);
    assert.deepEqual(spanNames(h.exporter), ["parse"]);
    assert.equal(h.exporter.traces[0].spans[0].attributes.error_code, "no_json");
  });

  it("a parse reply that fails the intent schema is schema_invalid", async () => {
    const models = fakeModels({ parse_intent: [{ json: { ...INTENT, budgetUsd: -5 } }] });
    failedAt(await runPipeline({ text: REQUEST_TEXT }, harness({ models }).deps), "parse", "schema_invalid");
  });

  it("a thrown model call is model_error with an error span and no tokens", async () => {
    const models = fakeModels({ parse_intent: [{ error: Object.assign(new Error("boom"), { name: "APIConnectionError" }) }] });
    const h = harness({ models });

    const result = failedAt(await runPipeline({ text: REQUEST_TEXT }, h.deps), "parse", "model_error");

    assert.deepEqual(result.audit.modelCalls, []);
    const [span] = h.exporter.traces[0].spans;
    assert.equal(span.attributes.status, "error");
    assert.equal(span.attributes.error_code, "APIConnectionError");
  });

  it("a truncated plan is a plan failure, not a partial itinerary", async () => {
    const models = fakeModels({
      parse_intent: [{ json: INTENT }],
      plan_itineraries: [{ json: { options: [OPTION_A, OPTION_B] }, stopReason: "max_tokens" }],
    });
    const h = harness({ models });

    failedAt(await runPipeline({ text: REQUEST_TEXT }, h.deps), "plan", "truncated");
    assert.equal(h.validations(), 0);
  });

  it("an oversized request fails redaction and calls no model", async () => {
    const models = fakeModels({});
    const result = failedAt(await runPipeline({ text: "a".repeat(5_000) }, harness({ models }).deps), "redact", "too_long");
    assert.equal(models.requests().length, 0);
    assert.equal(result.audit.totalCostUsd, 0);
  });

  it("Places down on every search: no candidates, so no plan call and nothing invented", async () => {
    const models = fakeModels({ parse_intent: [{ json: INTENT }] });
    const h = harness({ models, places: { combined: [{ status: 429 }, { status: 429 }] } });

    const result = failedAt(await runPipeline({ text: REQUEST_TEXT }, h.deps), "retrieve", "no_candidates");

    assert.deepEqual(result.retrievalGaps, [
      { stopType: "drinks", reason: "places_rate_limited" },
      { stopType: "dinner", reason: "places_rate_limited" },
    ]);
    assert.equal(models.requestsFor("plan_itineraries").length, 0);
    assert.deepEqual(result.intent, INTENT);
  });

  it("partial retrieval still plans from what came back and reports the gap", async () => {
    const intent = { ...INTENT, stopTypes: ["drinks", "dinner", "dessert"] };
    const starved = loadPlacesFixture("combined-dessert-starved");
    const noDessert = { places: starved.places.filter((place) => !place.id.startsWith("ChIJdes")) };
    const models = fakeModels({ parse_intent: [{ json: intent }], plan_itineraries: [plan(OPTION_A, OPTION_B)] });
    const h = harness({ models, places: { combined: [noDessert], dessert_shop: [{ status: 500 }] } });

    const result = completed(await runPipeline({ text: REQUEST_TEXT }, h.deps));

    assert.deepEqual(result.retrievalGaps, [{ stopType: "dessert", reason: "places_unavailable" }]);
    assert.ok(!models.requestsFor("plan_itineraries")[0].user.includes("ChIJdes"));
  });

  it("a retrieval port that throws is retrieval_error", async () => {
    const models = fakeModels({ parse_intent: [{ json: INTENT }] });
    const h = harness({ models, retrieve: async () => { throw new Error("coords cache offline"); } });
    failedAt(await runPipeline({ text: REQUEST_TEXT }, h.deps), "retrieve", "retrieval_error");
  });

  it("an aborted request rejects instead of returning a failure", async () => {
    const controller = new AbortController();
    const models = fakeModels({
      parse_intent: [{ error: new DOMException("aborted", "AbortError") }],
    });
    controller.abort();
    await assert.rejects(runPipeline({ text: REQUEST_TEXT, signal: controller.signal }, harness({ models }).deps));
  });
});
