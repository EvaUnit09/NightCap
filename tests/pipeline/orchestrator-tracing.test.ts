import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { hashRequest } from "../../src/monitoring";
import { resetConfig } from "../../src/models";
import { runPipeline } from "../../src/pipeline";
import { INTENT, OPTION_A, OPTION_B, fakeModels, harness, option, spanNames, spansNamed } from "./orchestrator-harness";

const PII_REQUEST = "Cozy drinks then dinner with Sarah Connor in the West Village, text me at (555) 123-4567";

async function tracedRun() {
  const broken = option("Lively bar and trattoria", ["ChIJbar1", "Employes Only"], ["ChIJdin1", "I Sodi"]);
  const models = fakeModels({
    parse_intent: [{ json: INTENT }],
    plan_itineraries: [{ json: { options: [OPTION_A, broken] } }],
    repair_itinerary: [{ json: OPTION_B }],
  });
  const h = harness({ models });
  await runPipeline({ text: PII_REQUEST, testCaseId: "nc-001" }, h.deps);
  return h.exporter;
}

describe("runPipeline tracing", () => {
  beforeEach(() => resetConfig());

  it("opens one request trace with a span per stage, in order", async () => {
    const exporter = await tracedRun();

    assert.equal(exporter.traces.length, 1);
    assert.equal(exporter.traces[0].name, "request");
    assert.deepEqual(spanNames(exporter), ["parse", "places.search", "rerank", "plan", "validate", "repair", "validate"]);
  });

  it("model spans carry prompt name and version, model, tokens, cost, and latency", async () => {
    const exporter = await tracedRun();
    const expected = {
      parse: ["parse_intent", "claude-haiku-4-5", 0.002],
      plan: ["plan_itineraries", "claude-sonnet-5", 0.004],
      repair: ["repair_itinerary", "claude-sonnet-5", 0.004],
    } as const;

    for (const [name, [promptName, model, cost]] of Object.entries(expected)) {
      const [span] = spansNamed(exporter, name);
      assert.equal(span.attributes.prompt_name, promptName, name);
      assert.equal(span.attributes.prompt_version, "v1", name);
      assert.equal(typeof span.attributes.prompt_hash, "string", name);
      assert.equal(span.attributes.model, model, name);
      assert.equal(span.attributes.input_tokens, 1000, name);
      assert.equal(span.attributes.output_tokens, 200, name);
      assert.ok(Math.abs(Number(span.attributes.cost_usd) - cost) < 1e-12, name);
      assert.equal(typeof span.attributes.latency_ms, "number", name);
      assert.equal(span.attributes.status, "ok", name);
      assert.equal(span.attributes.test_case_id, "nc-001", name);
    }
  });

  it("validate spans carry validation errors by type; the passing pass carries none", async () => {
    const exporter = await tracedRun();
    const codes = spansNamed(exporter, "validate").map((span) => span.attributes.outcome_codes);
    assert.deepEqual(codes, ["name_mismatch", undefined]);
  });

  it("the root carries the request hash and the allowlisted intent, and no span carries free text", async () => {
    const exporter = await tracedRun();
    const root = exporter.traces[0];

    assert.equal(root.attributes.request_hash, hashRequest(PII_REQUEST));
    assert.equal(root.attributes.test_case_id, "nc-001");
    assert.deepEqual(root.attributes.parsed_intent, {
      budgetUsd: 200,
      stopTypes: ["drinks", "dinner"],
      singleStop: false,
      window: INTENT.window,
      dietaryCount: 0,
      vibeTagCount: 1,
    });
    const exported = JSON.stringify(exporter.traces);
    for (const leak of ["Sarah", "555", "West Village", "cozy", "Little Branch", "Employes Only", "Fits a cozy night"]) {
      assert.ok(!exported.includes(leak), `trace leaked ${leak}`);
    }
  });
});
