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

interface DdTraceModule {
  readonly default: {
    init(options: object): unknown;
    readonly llmobs: unknown;
  };
}

type LoadDdTrace = () => Promise<DdTraceModule>;

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

function safeField(error: unknown, field: "code" | "name"): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" && SAFE_ERROR_CODE.test(value) ? value : undefined;
}

export function safeErrorCode(error: unknown): string {
  return safeField(error, "code") ?? safeField(error, "name") ?? UNKNOWN_ERROR_CODE;
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

function finalAttributes(span: TraceSpan): SpanAttributes {
  return span.resolveAttributes?.() ?? span.attributes;
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
        annotateSpan(client, ddSpan, finalAttributes(span), Date.now() - started, { status: "ok" });
        return result;
      } catch (error) {
        const code = safeErrorCode(error);
        annotateSpan(client, ddSpan, finalAttributes(span), Date.now() - started, {
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

async function initLlmobs(load: LoadDdTrace): Promise<LlmobsClient> {
  const tracer = (await load()).default;
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
  return tracer.llmobs as LlmobsClient;
}

/**
 * Init dd-trace LLM Observability only when a key is present and this is
 * a running server, never during `next build`. Plugins stay off so APM
 * auto-instrumentation cannot capture request bodies (#27). A failed init
 * leaves requests untraced rather than failing them.
 */
export async function registerDatadogTracing(
  load: LoadDdTrace = () => import("dd-trace"),
): Promise<void> {
  if (initAttempted || llmobs) {
    return;
  }
  if (isBuildPhase() || process.env.NEXT_RUNTIME === "edge") {
    return;
  }
  if (!getOptionalDdApiKey()) {
    return;
  }
  initAttempted = true;
  try {
    llmobs = await initLlmobs(load);
  } catch (error) {
    const name = safeField(error, "name") ?? UNKNOWN_ERROR_CODE;
    console.warn(`[monitoring] Datadog tracing disabled, continuing untraced: ${name}`);
  }
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
