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
      parse: ["parse_intent", "claude-haiku-5-5", 0.0002],
      plan: ["plan_itineraries", "claude-haiku-5-5", 0.0002],
      repair: ["repair_itinerary", "claude-haiku-5-5", 0.0002],
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

  it("model stages are task spans that hand their prompt name and version to the nested llm span", async () => {
    const exporter = await tracedRun();

    for (const [name, id] of [["parse", "parse_intent"], ["plan", "plan_itineraries"], ["repair", "repair_itinerary"]] as const) {
      const [span] = spansNamed(exporter, name);
      assert.equal(span.kind, "task", name);
      assert.equal(span.prompt?.id, id, name);
      assert.equal(span.prompt?.version, "v1", name);
      assert.equal(span.prompt?.tags?.prompt_hash, span.attributes.prompt_hash, name);
    }
    assert.equal(spansNamed(exporter, "validate")[0].prompt, undefined);
  });

  it("the root's input is the redacted request and its output the emitted place ids and names", async () => {
    const exporter = await tracedRun();
    const { io } = exporter.traces[0];

    assert.equal(typeof io.input, "string");
    assert.ok(io.input?.includes("West Village"), "redacted text keeps the area");
    for (const pii of ["Sarah", "Connor", "555", "123-4567"]) {
      assert.ok(!io.input?.includes(pii), `input kept ${pii}`);
    }
    assert.deepEqual(io.output, {
      status: "completed",
      options: [
        { stops: [{ placeId: "ChIJbar0", name: "Little Branch" }, { placeId: "ChIJdin0", name: "Via Carota" }] },
        { stops: [{ placeId: "ChIJbar1", name: "Employees Only" }, { placeId: "ChIJdin1", name: "I Sodi" }] },
      ],
    });
  });

  it("a failed request's output names the stage and code, not text", async () => {
    const models = fakeModels({ parse_intent: [{ text: "not json" }] });
    const h = harness({ models });
    await runPipeline({ text: PII_REQUEST }, h.deps);

    assert.deepEqual(h.exporter.traces[0].io.output, { status: "failed", stage: "parse", code: "no_json" });
  });

  it("the root carries the request hash and the allowlisted intent; free text stays out of every attribute", async () => {
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
    const attributes = JSON.stringify(exporter.traces.map(({ attributes: rootAttrs, spans }) => ({ rootAttrs, spans })));
    for (const leak of ["Sarah", "555", "West Village", "cozy", "Little Branch", "Employes Only", "Employees Only", "Via Carota", "Fits a cozy night"]) {
      assert.ok(!attributes.includes(leak), `attributes leaked ${leak}`);
    }
  });

  it("no API key value or the request hash secret appears anywhere in the trace, input and output included", async () => {
    const secrets = {
      ANTHROPIC_API_KEY: "sk-ant-sentinel-anthropic-0001",
      GOOGLE_PLACES_API_KEY: "AIza-sentinel-places-0002",
      DD_API_KEY: "dd-sentinel-datadog-0003",
      REQUEST_HASH_SECRET: "hash-secret-sentinel-0004",
    };
    const saved = { ...process.env };
    Object.assign(process.env, secrets);
    resetConfig();
    try {
      const exporter = await tracedRun();
      const exported = JSON.stringify(exporter.traces);
      for (const [name, value] of Object.entries(secrets)) {
        assert.ok(!exported.includes(value), `trace leaked ${name}`);
      }
    } finally {
      process.env = saved;
      resetConfig();
    }
  });
});
