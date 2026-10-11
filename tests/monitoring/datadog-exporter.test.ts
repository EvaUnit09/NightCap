import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { resetConfig } from "../../src/models";
import {
  createDatadogExporter,
  registerDatadogTracing,
  resetDatadogTracingForTests,
  safeErrorCode,
  traceWithClient,
  type LlmobsAnnotation,
  type LlmobsClient,
} from "../../src/monitoring/datadog-exporter";
import { hashRequest } from "../../src/monitoring";
import type { TraceSpan } from "../../src/monitoring/trace-types";

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
  const client: LlmobsClient = {
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
  return { client, annotations, errorsSeenByTracer };
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
        llmobs: {},
      },
    }),
    "the dd-trace import rejects": async () => {
      throw new RangeError(LEAKY_MESSAGE);
    },
  };

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
