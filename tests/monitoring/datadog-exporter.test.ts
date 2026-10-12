import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { resetConfig } from "../../src/models";
import {
  createDatadogExporter,
  ENABLED_INTEGRATIONS,
  PRELOADED_TRACER_WARNING,
  registerDatadogTracing,
  resetDatadogTracingForTests,
  safeErrorCode,
  traceWithClient,
  type LlmobsAnnotation,
  type LlmobsClient,
} from "../../src/monitoring/datadog-exporter";
import { hashRequest } from "../../src/monitoring";
import type { LlmPrompt, TraceSpan } from "../../src/monitoring/trace-types";

const LEAKY_MESSAGE = 'Unexpected token in JSON: "dinner with Sarah at 8"';

const ROOT_SPAN: TraceSpan = {
  name: "request",
  kind: "workflow",
  attributes: {
    request_hash: hashRequest("dinner with Sarah at 8"),
    parsed_intent: { valid: false },
  },
};

function fakeClient() {
  const annotations: LlmobsAnnotation[] = [];
  const errorsSeenByTracer: unknown[] = [];
  const prompts: LlmPrompt[] = [];
  let insidePrompt = false;
  const client: LlmobsClient = {
    annotationContext<T>(options: { prompt: LlmPrompt }, fn: () => T): T {
      prompts.push(options.prompt);
      insidePrompt = true;
      try {
        return fn();
      } finally {
        insidePrompt = false;
      }
    },
    annotate(_span, options) {
      annotations.push(options);
    },
    trace<T>(_options: unknown, fn: (span: unknown) => T | Promise<T>): Promise<T> {
      return Promise.resolve()
        .then(() => fn({}))
        .catch((error: unknown) => {
          errorsSeenByTracer.push(error);
          throw error;
        });
    },
  };
  return { client, annotations, errorsSeenByTracer, prompts, isInsidePrompt: () => insidePrompt };
}

describe("traceWithClient", () => {
  it("rethrows the original error to the caller but shows the tracer only a safe code", async () => {
    const { client, annotations, errorsSeenByTracer } = fakeClient();
    const original = new SyntaxError(LEAKY_MESSAGE);

    await assert.rejects(
      traceWithClient(client, ROOT_SPAN, () => {
        throw original;
      }),
      (error) => error === original,
    );

    assert.equal(errorsSeenByTracer.length, 1);
    const seen = errorsSeenByTracer[0] as Error;
    assert.notEqual(seen, original);
    assert.deepEqual(
      { name: seen.name, message: seen.message, stack: seen.stack },
      { name: "SyntaxError", message: "SyntaxError", stack: "SyntaxError" },
    );
    assert.equal(annotations.length, 1);
    assert.equal(annotations[0].tags?.status, "error");
    assert.equal(annotations[0].tags?.error_code, "SyntaxError");
    assert.equal(typeof annotations[0].metrics?.latency_ms, "number");
    assert.equal(JSON.stringify(annotations).includes("Sarah"), false);
  });

  it("returns the result and tags the span ok on success", async () => {
    const { client, annotations, errorsSeenByTracer } = fakeClient();

    const result = await traceWithClient(client, ROOT_SPAN, async () => 42);

    assert.equal(result, 42);
    assert.deepEqual(errorsSeenByTracer, []);
    assert.equal(annotations.length, 1);
    assert.equal(annotations[0].tags?.status, "ok");
    assert.equal("error_code" in (annotations[0].tags ?? {}), false);
    assert.deepEqual(annotations[0].metadata, { parsed_intent: { valid: false } });
    assert.equal("parsed_intent" in (annotations[0].tags ?? {}), false);
  });
});

describe("traceWithClient input, output, and prompt", () => {
  it("sends the recorded request and venues only as LLM Obs input and output", async () => {
    const { client, annotations } = fakeClient();
    const output = { status: "completed", options: [{ stops: [{ placeId: "ChIJbar0", name: "Little Branch" }] }] } as const;

    await traceWithClient(client, { ...ROOT_SPAN, resolveIO: () => ({ input: "dinner with [NAME] at 8", output }) }, () => 1);

    assert.equal(annotations[0].inputData, "dinner with [NAME] at 8");
    assert.deepEqual(annotations[0].outputData, output);
    const rest = JSON.stringify([annotations[0].tags, annotations[0].metadata, annotations[0].metrics]);
    assert.equal(rest.includes("Little Branch"), false);
    assert.equal(rest.includes("[NAME]"), false);
  });

  it("runs a stage's work inside its prompt's annotation context, and spans without one outside any", async () => {
    const { client, prompts, isInsidePrompt } = fakeClient();
    const prompt = { id: "plan_itineraries", version: "v1", tags: { prompt_hash: "abc" } };
    const stage: TraceSpan = { name: "plan", kind: "task", attributes: { stage: "plan", request_hash: ROOT_SPAN.attributes.request_hash }, prompt };

    const inside = await traceWithClient(client, stage, () => isInsidePrompt());
    const outside = await traceWithClient(client, ROOT_SPAN, () => isInsidePrompt());

    assert.equal(inside, true);
    assert.equal(outside, false);
    assert.deepEqual(prompts, [prompt]);
  });
});

describe("safeErrorCode", () => {
  it("prefers a safe string code, then a safe name, then a fixed fallback", () => {
    const withCode = Object.assign(new Error(LEAKY_MESSAGE), { code: "ECONNRESET" });
    const unsafeCode = Object.assign(new TypeError(LEAKY_MESSAGE), { code: "dinner with Sarah" });
    const unsafeName = Object.assign(new Error(LEAKY_MESSAGE), { name: "Sarah's error" });

    assert.equal(safeErrorCode(withCode), "ECONNRESET");
    assert.equal(safeErrorCode(unsafeCode), "TypeError");
    assert.equal(safeErrorCode(unsafeName), "UnknownError");
    assert.equal(safeErrorCode(LEAKY_MESSAGE), "UnknownError");
    assert.equal(safeErrorCode(undefined), "UnknownError");
  });
});

describe("registerDatadogTracing", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.DD_API_KEY = "ci-placeholder-not-a-real-key";
    resetConfig();
    resetDatadogTracingForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    resetDatadogTracingForTests();
  });

  const failingLoaders = {
    "tracer.init throws": async () => ({
      default: {
        init(): never {
          throw new RangeError(LEAKY_MESSAGE);
        },
        use: () => undefined,
        llmobs: {},
      },
    }),
    "the dd-trace import rejects": async () => {
      throw new RangeError(LEAKY_MESSAGE);
    },
  };

  it("turns every dd-trace plugin off and then on only the Anthropic integration", async () => {
    const inits: Record<string, unknown>[] = [];
    const used: string[] = [];
    const load = async () => ({
      default: {
        init(options: Record<string, unknown>) {
          inits.push(options);
        },
        use(integration: string, enabled: true) {
          assert.equal(enabled, true);
          used.push(integration);
        },
        llmobs: {},
      },
    });

    await registerDatadogTracing(load);

    assert.deepEqual(ENABLED_INTEGRATIONS, ["anthropic"]);
    assert.equal(inits.length, 1);
    assert.equal(inits[0].plugins, false);
    assert.deepEqual(used, ["anthropic"]);
    for (const banned of ["http", "https", "fetch", "undici", "net", "dns"]) {
      assert.equal(used.includes(banned), false, `${banned} plugin enabled`);
    }
  });

  it("refuses to trace, with a warning, when a preload already initialized dd-trace with its default plugins", async (t) => {
    const warn = t.mock.method(console, "warn", () => undefined);
    const calls: string[] = [];
    const llmobs = {
      trace: () => assert.fail("traced through a preloaded tracer"),
      annotate: () => undefined,
      annotationContext: () => undefined,
    };
    const load = async () => ({
      default: {
        _initialized: true,
        init: () => calls.push("init"),
        use: () => calls.push("use"),
        llmobs,
      },
    });

    await registerDatadogTracing(load);
    const result = await createDatadogExporter().wrap(ROOT_SPAN, () => 7);

    assert.equal(result, 7, "the work still runs, untraced");
    assert.deepEqual(calls, [], "neither init nor use runs on a tracer someone else configured");
    assert.deepEqual(warn.mock.calls.map((call) => call.arguments[0]), [PRELOADED_TRACER_WARNING]);
  });

  it("traces through a second bundled copy of this module once the first copy initialized dd-trace", async (t) => {
    const warn = t.mock.method(console, "warn", () => undefined);
    const { client, annotations } = fakeClient();
    const calls: string[] = [];
    const tracer = {
      _initialized: false,
      init() {
        calls.push("init");
        tracer._initialized = true;
      },
      use: (integration: string) => calls.push(`use:${integration}`),
      llmobs: client,
    };
    const load = async () => ({ default: tracer });
    const secondCopy = (await import(
      `../../src/monitoring/datadog-exporter.ts?copy=${Date.now()}`
    )) as typeof import("../../src/monitoring/datadog-exporter");
    t.after(() => secondCopy.resetDatadogTracingForTests());

    await registerDatadogTracing(load);
    await secondCopy.registerDatadogTracing(load);
    const result = await secondCopy.createDatadogExporter().wrap(ROOT_SPAN, () => 7);

    assert.equal(result, 7);
    assert.equal(annotations.length, 1, "the second copy traced the request");
    assert.deepEqual(calls, ["init", "use:anthropic"], "dd-trace is configured once, by the first copy");
    assert.equal(warn.mock.callCount(), 0);
  });

  for (const [label, load] of Object.entries(failingLoaders)) {
    it(`continues untraced with one name-only warning when ${label}`, async (t) => {
      const warn = t.mock.method(console, "warn", () => undefined);

      await assert.doesNotReject(registerDatadogTracing(load));
      const result = await createDatadogExporter().wrap(ROOT_SPAN, () => 7);

      assert.equal(result, 7);
      assert.equal(warn.mock.callCount(), 1);
      const logged = warn.mock.calls[0].arguments.join(" ");
      assert.match(logged, /RangeError/);
      assert.equal(logged.includes("Sarah"), false);
    });
  }
});
