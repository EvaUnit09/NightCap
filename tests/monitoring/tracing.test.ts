import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createExporter,
  createMemoryExporter,
  hashRequest,
  withRequestTrace,
  withStage,
  TRACE_STAGES,
} from "../../src/monitoring";
import {
  assertProductionRequestHashSecret,
  DEV_TEST_REQUEST_HASH_SECRET,
  getRequestHashSecret,
  resetConfig,
} from "../../src/models";
import { getModelFor } from "../../src/models/router";
import { getPromptTraceTags, loadPrompt } from "../../src/pipeline";

const PII_REQUEST =
  "Dinner with Sarah near Union Square. Email jane@example.com or call (555) 123-4567.";

const PII_INTENT = {
  area: "Union Square with Sarah, email jane@example.com",
  window: {
    start: "2026-10-11T19:00:00-04:00",
    end: "2026-10-11T23:00:00-04:00",
  },
  budgetUsd: 150,
  dietary: ["vegetarian, with Sarah"],
  vibeTags: ["low-key night with Sarah", "call (555) 123-4567"],
  stopTypes: ["dinner", "drinks"],
  singleStop: false,
};

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

function allAttributes(exporter: ReturnType<typeof createMemoryExporter>): unknown[] {
  return exporter.traces.flatMap((trace) => [
    trace.attributes,
    ...trace.spans.map((span) => span.attributes),
  ]);
}

describe("Datadog LLM Observability tracing", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetConfig();
    delete process.env.DD_API_KEY;
    delete process.env.DATADOG_API_KEY;
    delete process.env.REQUEST_HASH_SECRET;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
  });

  it("opens one trace per request with one child span per stage", async () => {
    const exporter = createMemoryExporter();
    const prompt = loadPrompt("parse_intent", "v1");
    const promptTags = getPromptTraceTags(prompt);

    await withRequestTrace(
      {
        requestText: "a night out in Brooklyn",
        parsedIntent: {
          area: "Brooklyn",
          window: PII_INTENT.window,
          budgetUsd: 120,
          dietary: [],
          vibeTags: ["low-key"],
          stopTypes: ["dinner", "drinks"],
          singleStop: false,
        },
        testCaseId: "eval-case-01",
        exporter,
      },
      async () => {
        await withStage(
          {
            stage: "parse",
            model: getModelFor("parse_intent"),
            promptTags,
            inputTokens: 120,
            outputTokens: 40,
            costUsd: 0.002,
          },
          async () => "parsed",
        );
        await withStage({ stage: "places.search", cache: "miss" }, async () => "places");
        await withStage({ stage: "rerank" }, async () => "rerank");
        await withStage(
          {
            stage: "plan",
            model: getModelFor("plan_itineraries"),
            promptTags: getPromptTraceTags(loadPrompt("plan_itineraries", "v1")),
          },
          async () => "plan",
        );
        await withStage(
          { stage: "validate", outcomeCodes: ["closed", "over_budget"] },
          async () => "validate",
        );
        await withStage(
          {
            stage: "repair",
            model: getModelFor("repair_itinerary"),
            outcomeCodes: ["ok"],
          },
          async () => "repair",
        );
        await withStage({ stage: "stream" }, async () => "stream");
      },
    );

    assert.equal(exporter.traces.length, 1);
    const trace = exporter.traces[0];
    assert.equal(trace.name, "request");
    assert.deepEqual(
      trace.spans.map((span) => span.name),
      ["parse", "places.search", "rerank", "plan", "validate", "repair", "stream"],
    );

    const parse = trace.spans[0];
    assert.equal(parse.attributes.stage, "parse");
    assert.equal(parse.attributes.model, getModelFor("parse_intent"));
    assert.equal(parse.attributes.prompt_hash, promptTags.prompt_hash);
    assert.equal(parse.attributes.prompt_rendered_hash, promptTags.prompt_rendered_hash);
    assert.equal(parse.attributes.input_tokens, 120);
    assert.equal(parse.attributes.output_tokens, 40);
    assert.equal(parse.attributes.cost_usd, 0.002);
    assert.equal(typeof parse.attributes.latency_ms, "number");

    assert.equal(trace.spans[1].attributes.cache, "miss");
    assert.equal(trace.spans[4].attributes.outcome_codes, "closed,over_budget");
    assert.equal(trace.spans[5].attributes.outcome_codes, "ok");
    assert.equal(trace.attributes.test_case_id, "eval-case-01");
    assert.equal(typeof trace.attributes.request_hash, "string");
    assert.match(String(trace.attributes.request_hash), /^[0-9a-f]{64}$/);
    assert.ok(TRACE_STAGES.includes("agent"));
  });

  it("never puts the raw request or user_text on spans, even with name/email/phone", async () => {
    const exporter = createMemoryExporter();

    await withRequestTrace(
      {
        requestText: PII_REQUEST,
        parsedIntent: PII_INTENT,
        exporter,
      },
      async () => {
        await withStage({ stage: "parse", model: getModelFor("parse_intent") }, async () => {
          return { user_text: PII_REQUEST };
        });
        await withStage({ stage: "plan" }, async () => undefined);
      },
    );

    const blob = serialized(exporter.traces);
    assert.equal(blob.includes(PII_REQUEST), false, "raw request leaked into spans");
    assert.equal(blob.includes("jane@example.com"), false, "email leaked into spans");
    assert.equal(blob.includes("(555) 123-4567"), false, "phone leaked into spans");
    assert.equal(blob.includes("555-123-4567"), false, "phone leaked into spans");
    assert.equal(blob.includes("user_text"), false, "user_text key leaked into spans");

    for (const attrs of allAttributes(exporter)) {
      assert.ok(attrs && typeof attrs === "object");
      assert.equal("user_text" in attrs, false);
      assert.equal("request_text" in attrs, false);
      assert.equal("redacted_text" in attrs, false);
    }
  });

  it("HMAC-SHA256 request hash depends on the secret", () => {
    const text = "short";
    const a = hashRequest(text, "secret-alpha-aaaaaaaa");
    const b = hashRequest(text, "secret-bravo-bbbbbbbb");
    assert.notEqual(a, b);
    assert.equal(hashRequest(text, "secret-alpha-aaaaaaaa"), a);
    assert.notEqual(a, createHash("sha256").update(text, "utf8").digest("hex"));
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it("redacts parsed_intent free-text fields before they land on a span", async () => {
    const exporter = createMemoryExporter();

    await withRequestTrace(
      {
        requestText: PII_REQUEST,
        parsedIntent: PII_INTENT,
        exporter,
      },
      async () => {
        await withStage({ stage: "parse" }, async () => undefined);
      },
    );

    const intent = exporter.traces[0].attributes.parsed_intent;
    assert.ok(intent && typeof intent === "object");
    const record = intent as Record<string, unknown>;
    assert.equal(typeof record.area, "string");
    assert.match(String(record.area), /\[NAME\]/);
    assert.equal(String(record.area).includes("Sarah"), false);
    assert.equal(String(record.area).includes("jane@example.com"), false);

    const dietary = record.dietary;
    assert.ok(Array.isArray(dietary));
    assert.equal(
      dietary.some((value) => String(value).includes("Sarah")),
      false,
    );
    assert.ok(dietary.some((value) => String(value).includes("[NAME]")));

    const vibeTags = record.vibeTags;
    assert.ok(Array.isArray(vibeTags));
    assert.equal(
      vibeTags.some((value) => String(value).includes("Sarah")),
      false,
    );
    assert.equal(
      vibeTags.some((value) => String(value).includes("(555) 123-4567")),
      false,
    );
    assert.ok(record.people === undefined);
  });

  it("drops a people field from span payload without requiring it on the intent schema", async () => {
    const exporter = createMemoryExporter();

    await withRequestTrace(
      {
        requestText: "a night out",
        parsedIntent: {
          area: "Brooklyn",
          window: PII_INTENT.window,
          budgetUsd: 80,
          dietary: ["vegetarian"],
          vibeTags: ["low-key"],
          stopTypes: ["dinner", "drinks"],
          singleStop: false,
          people: ["Sarah"],
        },
        exporter,
      },
      async () => undefined,
    );

    const intent = exporter.traces[0].attributes.parsed_intent as Record<string, unknown>;
    assert.equal("people" in intent, false);
    const blob = serialized(exporter.traces);
    assert.equal(blob.includes("Sarah"), false);
  });

  it("selects the datadog exporter when DD_API_KEY is set, without sending", () => {
    process.env.DD_API_KEY = "ci-placeholder-not-a-real-key";
    resetConfig();
    assert.equal(createExporter().kind, "datadog");
  });

  it("falls back to a no-op exporter when DD_API_KEY is missing and does not throw", async () => {
    delete process.env.DD_API_KEY;
    delete process.env.DATADOG_API_KEY;
    resetConfig();

    const exporter = createExporter();
    assert.equal(exporter.kind, "noop");
    await assert.doesNotReject(() =>
      withRequestTrace({ requestText: PII_REQUEST, parsedIntent: PII_INTENT }, async () => {
        await withStage({ stage: "parse" }, async () => "ok");
      }),
    );
    await assert.doesNotReject(() => exporter.wrap({
      name: "request",
      kind: "workflow",
      attributes: { request_hash: "abc" },
    }, async () => "ok"));
  });

  it("withStage outside a request still runs and does not throw", async () => {
    const result = await withStage({ stage: "validate" }, async () => 7);
    assert.equal(result, 7);
  });

  it("uses the marked dev/test HMAC key when REQUEST_HASH_SECRET is unset", () => {
    delete process.env.REQUEST_HASH_SECRET;
    resetConfig();
    assert.equal(getRequestHashSecret(), DEV_TEST_REQUEST_HASH_SECRET);
    assert.match(DEV_TEST_REQUEST_HASH_SECRET, /not-for-production/);
    assert.equal(
      hashRequest("hello"),
      hashRequest("hello", DEV_TEST_REQUEST_HASH_SECRET),
    );
  });
});

describe("REQUEST_HASH_SECRET production gate", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetConfig();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
  });

  function setNodeEnv(value: string) {
    Object.assign(process.env, { NODE_ENV: value });
  }

  it("throws in production without REQUEST_HASH_SECRET", () => {
    setNodeEnv("production");
    delete process.env.NEXT_PHASE;
    delete process.env.REQUEST_HASH_SECRET;
    assert.throws(
      () => assertProductionRequestHashSecret(),
      /REQUEST_HASH_SECRET/,
    );
  });

  it("throws in production when the secret is the marked test key", () => {
    setNodeEnv("production");
    delete process.env.NEXT_PHASE;
    process.env.REQUEST_HASH_SECRET = DEV_TEST_REQUEST_HASH_SECRET;
    assert.throws(
      () => assertProductionRequestHashSecret(),
      /REQUEST_HASH_SECRET/,
    );
  });

  it("is ok in production with a real secret", () => {
    setNodeEnv("production");
    delete process.env.NEXT_PHASE;
    process.env.REQUEST_HASH_SECRET = "production-request-hash-secret";
    assert.doesNotThrow(() => assertProductionRequestHashSecret());
  });

  it("is ok in development without the secret", () => {
    setNodeEnv("development");
    delete process.env.NEXT_PHASE;
    delete process.env.REQUEST_HASH_SECRET;
    assert.doesNotThrow(() => assertProductionRequestHashSecret());
    assert.doesNotThrow(() => getRequestHashSecret());
  });

  it("skips the check during next build", () => {
    setNodeEnv("production");
    process.env.NEXT_PHASE = "phase-production-build";
    delete process.env.REQUEST_HASH_SECRET;
    assert.doesNotThrow(() => assertProductionRequestHashSecret());
  });
});

describe("tracing stays server-only", () => {
  const monitoringDir = dirname(fileURLToPath(new URL("../../src/monitoring/tracing.ts", import.meta.url)));

  it("keeps tracing files behind server-only", () => {
    const files = readdirSync(monitoringDir).filter((name) => name.endsWith(".ts"));
    assert.ok(files.includes("tracing.ts"));
    for (const name of files) {
      const source = readFileSync(join(monitoringDir, name), "utf8");
      assert.match(source, /import ["']server-only["']/, `${name} must import server-only`);
    }
  });

  it("is not imported from app/ client files", () => {
    const appDir = fileURLToPath(new URL("../../app", import.meta.url));
    const stack = [appDir];
    const hits: string[] = [];
    while (stack.length > 0) {
      const dir = stack.pop();
      if (!dir) break;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(path);
          continue;
        }
        if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
        const source = readFileSync(path, "utf8");
        if (source.includes("src/monitoring") || source.includes("monitoring/tracing")) {
          hits.push(path);
        }
      }
    }
    assert.deepEqual(hits, []);
  });
});
