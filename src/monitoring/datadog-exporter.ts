import "server-only";

import { getOptionalDdApiKey } from "../models/config";
import type { SpanAttributes, SpanKind, TraceExporter, TraceSpan } from "./trace-types";

export interface LlmobsAnnotation {
  readonly tags?: Record<string, string>;
  readonly metadata?: Record<string, unknown>;
  readonly metrics?: Record<string, number>;
}

/** The slice of dd-trace's `tracer.llmobs` this exporter calls. */
export interface LlmobsClient {
  annotate(span: unknown, options: LlmobsAnnotation): void;
  trace<T>(
    options: { name: string; kind: SpanKind },
    fn: (span: unknown) => T | Promise<T>,
  ): T | Promise<T>;
}

type SpanOutcome = { status: "ok" } | { status: "error"; error_code: string };

const SAFE_ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const UNKNOWN_ERROR_CODE = "UnknownError";

const originalErrors = new WeakMap<Error, unknown>();

let llmobs: LlmobsClient | null = null;
let initAttempted = false;

function isBuildPhase(): boolean {
  const phase = process.env.NEXT_PHASE;
  if (phase && (phase.includes("build") || phase.includes("export"))) {
    return true;
  }
  return process.env.npm_lifecycle_event === "build";
}

function flattenTags(attributes: Record<string, unknown>): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      tags[key] = String(value);
    }
  }
  return tags;
}

function metricsFrom(attributes: Record<string, unknown>): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const key of ["latency_ms", "input_tokens", "output_tokens", "cost_usd"] as const) {
    const value = attributes[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      metrics[key] = value;
    }
  }
  return metrics;
}

export function safeErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return UNKNOWN_ERROR_CODE;
  }
  const { code, name } = error as { code?: unknown; name?: unknown };
  if (typeof code === "string" && SAFE_ERROR_CODE.test(code)) {
    return code;
  }
  if (typeof name === "string" && SAFE_ERROR_CODE.test(name)) {
    return name;
  }
  return UNKNOWN_ERROR_CODE;
}

/**
 * dd-trace copies `message` and `stack` of the error it sees into the
 * exported event, and model output can echo the user's words into either.
 */
function redactedError(original: unknown, code: string): Error {
  const error = new Error(code);
  error.name = code;
  error.stack = code;
  originalErrors.set(error, original);
  return error;
}

function annotateSpan(
  client: LlmobsClient,
  ddSpan: unknown,
  attributes: SpanAttributes,
  latencyMs: number,
  outcome: SpanOutcome,
): void {
  const { parsed_intent: parsedIntent, ...rest } = attributes as Record<string, unknown>;
  const measured = { ...rest, latency_ms: latencyMs };
  client.annotate(ddSpan, {
    tags: flattenTags({ ...measured, ...outcome }),
    metadata: parsedIntent === undefined ? undefined : { parsed_intent: parsedIntent },
    metrics: metricsFrom(measured),
  });
}

/** Trace `fn` through `client`; the caller always gets `fn`'s own result or error. */
export async function traceWithClient<T>(
  client: LlmobsClient,
  span: TraceSpan,
  fn: () => Promise<T> | T,
): Promise<T> {
  const started = Date.now();
  try {
    return await client.trace({ name: span.name, kind: span.kind }, async (ddSpan) => {
      try {
        const result = await fn();
        annotateSpan(client, ddSpan, span.attributes, Date.now() - started, { status: "ok" });
        return result;
      } catch (error) {
        const code = safeErrorCode(error);
        annotateSpan(client, ddSpan, span.attributes, Date.now() - started, {
          status: "error",
          error_code: code,
        });
        throw redactedError(error, code);
      }
    });
  } catch (error) {
    throw error instanceof Error && originalErrors.has(error) ? originalErrors.get(error) : error;
  }
}

/**
 * Init dd-trace LLM Observability only when a key is present and this is
 * a running server, never during `next build`. Plugins stay off so APM
 * auto-instrumentation cannot capture request bodies (#27).
 */
export async function registerDatadogTracing(): Promise<void> {
  if (initAttempted || llmobs) {
    return;
  }
  if (isBuildPhase() || process.env.NEXT_RUNTIME === "edge") {
    return;
  }
  const apiKey = getOptionalDdApiKey();
  if (!apiKey) {
    return;
  }
  initAttempted = true;
  const dd = await import("dd-trace");
  const tracer = dd.default;
  tracer.init({
    llmobs: {
      mlApp: process.env.DD_LLMOBS_ML_APP ?? "nightcap",
      agentlessEnabled: true,
    },
    site: process.env.DD_SITE ?? "datadoghq.com",
    plugins: false,
    runtimeMetrics: false,
    logInjection: false,
  });
  llmobs = tracer.llmobs as unknown as LlmobsClient;
}

export function resetDatadogTracingForTests(): void {
  llmobs = null;
  initAttempted = false;
}

export function createDatadogExporter(): TraceExporter {
  return {
    kind: "datadog",
    async wrap<T>(span: TraceSpan, fn: () => Promise<T> | T): Promise<T> {
      if (!llmobs) {
        await registerDatadogTracing();
      }
      return llmobs ? traceWithClient(llmobs, span, fn) : await fn();
    },
  };
}
