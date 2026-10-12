import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMemoryExporter, hashRequest, withRequestTrace, withStage } from "../../src/monitoring";
import {
  traceWithClient,
  type LlmobsAnnotation,
  type LlmobsClient,
} from "../../src/monitoring/datadog-exporter";

describe("withStage recorder", () => {
  it("merges measurements recorded after the work into the span, through the allowlist", async () => {
    const exporter = createMemoryExporter();
    const requestText = "dinner near union square";

    await withRequestTrace({ requestText, exporter, testCaseId: "nc-007" }, () =>
      withStage({ stage: "plan", model: "claude-sonnet-5" }, (span) => {
        span.record({ inputTokens: 10, costUsd: 0.5 });
        span.record({ outputTokens: 3, model: requestText, outcomeCodes: ["closed", "closed"] });
      }),
    );

    const [span] = exporter.traces[0].spans;
    assert.equal(span.attributes.input_tokens, 10);
    assert.equal(span.attributes.output_tokens, 3);
    assert.equal(span.attributes.cost_usd, 0.5);
    assert.equal(span.attributes.outcome_codes, "closed,closed");
    assert.equal(span.attributes.model, "claude-sonnet-5", "a recorded value that fails the allowlist is dropped");
    assert.ok(!JSON.stringify(exporter.traces).includes(requestText));
    assert.equal(span.attributes.test_case_id, "nc-007", "stage spans inherit the request's test case id");
  });

  it("records the parsed intent on the root once parse has run", async () => {
    const exporter = createMemoryExporter();
    const intent = {
      area: "Union Square",
      window: { start: "2026-10-16T19:00:00-04:00", end: "2026-10-16T23:00:00-04:00" },
      budgetUsd: 150,
      dietary: ["vegetarian"],
      vibeTags: [],
      stopTypes: ["drinks", "dinner"],
      singleStop: false,
    };

    await withRequestTrace({ requestText: "r", exporter }, (request) => request.recordParsedIntent(intent));

    assert.deepEqual(exporter.traces[0].attributes.parsed_intent, {
      budgetUsd: 150,
      stopTypes: ["drinks", "dinner"],
      singleStop: false,
      window: intent.window,
      dietaryCount: 1,
      vibeTagCount: 0,
    });
  });

  it("outside a request trace the callback still runs with a no-op recorder", async () => {
    const value = await withStage({ stage: "validate" }, (span) => {
      span.record({ outcomeCodes: ["closed"] });
      return 42;
    });
    assert.equal(value, 42);
  });

  it("the Datadog exporter annotates the resolved attributes, not the opening ones", async () => {
    const annotations: LlmobsAnnotation[] = [];
    const client: LlmobsClient = {
      annotate: (_span, options) => annotations.push(options),
      trace: (_options, fn) => fn({}),
      annotationContext: (_options, fn) => fn(),
    };
    const opened = { stage: "repair", request_hash: hashRequest("r") } as const;

    await traceWithClient(
      client,
      { name: "repair", kind: "task", attributes: opened, resolveAttributes: () => ({ ...opened, input_tokens: 7 }) },
      () => undefined,
    );

    assert.equal(annotations[0].tags?.input_tokens, "7");
  });

  it("stage tokens are tags, not metrics, so the nested llm span's token metrics are not counted twice", async () => {
    const annotations: LlmobsAnnotation[] = [];
    const client: LlmobsClient = {
      annotate: (_span, options) => annotations.push(options),
      trace: (_options, fn) => fn({}),
      annotationContext: (_options, fn) => fn(),
    };
    const opened = { stage: "plan", request_hash: hashRequest("r"), input_tokens: 7, output_tokens: 3, cost_usd: 0.1 } as const;

    await traceWithClient(client, { name: "plan", kind: "task", attributes: opened }, () => undefined);

    assert.deepEqual(Object.keys(annotations[0].metrics ?? {}), ["latency_ms"]);
  });
});
