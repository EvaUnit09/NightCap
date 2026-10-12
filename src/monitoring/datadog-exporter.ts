import "server-only";

import { getOptionalDdApiKey } from "../models/config";
import type {
  LlmPrompt,
  RequestOutput,
  SpanAttributes,
  SpanIO,
  SpanKind,
  TraceExporter,
  TraceSpan,
} from "./trace-types";

export interface LlmobsAnnotation {
  readonly inputData?: string;
  readonly outputData?: RequestOutput;
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
  annotationContext<T>(options: { prompt: LlmPrompt }, fn: () => T): T;
}

/**
 * The only dd-trace integrations turned on (#42). `anthropic` makes each
 * Messages call an `llm` span with its prompt, reply, tokens, and cost.
 * `http`, `fetch`, and every other plugin stay off, so Places and Routes
 * requests and their key headers are never traced.
 */
export const ENABLED_INTEGRATIONS = ["anthropic"] as const;

interface DdTraceModule {
  readonly default: {
    init(options: object): unknown;
    use(integration: (typeof ENABLED_INTEGRATIONS)[number], enabled: true): unknown;
    readonly llmobs: unknown;
    /** dd-trace 5.x's proxy flag. Its `init` returns early once set, ignoring our options. */
    readonly _initialized?: boolean;
  };
}

export const PRELOADED_TRACER_WARNING =
  "[monitoring] Datadog tracing disabled: dd-trace was already initialized (NODE_OPTIONS or --require/--import of dd-trace/init), " +
  "so its default plugins, http and fetch included, are on and plugins:false cannot apply. Preload only dd-trace/register.js.";

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

/**
 * Tokens and cost stay tags here: the nested `llm` span carries them as
 * metrics, and a second copy on the stage would count them twice.
 */
function annotateSpan(
  client: LlmobsClient,
  ddSpan: unknown,
  span: TraceSpan,
  latencyMs: number,
  outcome: SpanOutcome,
): void {
  const { parsed_intent: parsedIntent, ...rest } = finalAttributes(span) as Record<string, unknown>;
  const io: SpanIO = span.resolveIO?.() ?? {};
  client.annotate(ddSpan, {
    inputData: io.input,
    outputData: io.output,
    tags: flattenTags({ ...rest, latency_ms: latencyMs, ...outcome }),
    metadata: parsedIntent === undefined ? undefined : { parsed_intent: parsedIntent },
    metrics: { latency_ms: latencyMs },
  });
}

function finalAttributes(span: TraceSpan): SpanAttributes {
  return span.resolveAttributes?.() ?? span.attributes;
}

function withPrompt<T>(client: LlmobsClient, span: TraceSpan, fn: () => Promise<T> | T): Promise<T> | T {
  const { prompt } = span;
  return prompt ? client.annotationContext({ prompt }, fn) : fn();
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
        const result = await withPrompt(client, span, fn);
        annotateSpan(client, ddSpan, span, Date.now() - started, { status: "ok" });
        return result;
      } catch (error) {
        const code = safeErrorCode(error);
        annotateSpan(client, ddSpan, span, Date.now() - started, {
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

/** Null when another init got there first: its plugins would trace Places and Routes. */
async function initLlmobs(load: LoadDdTrace): Promise<LlmobsClient | null> {
  const tracer = (await load()).default;
  if (tracer._initialized === true) {
    console.warn(PRELOADED_TRACER_WARNING);
    return null;
  }
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
  for (const integration of ENABLED_INTEGRATIONS) {
    tracer.use(integration, true);
  }
  return tracer.llmobs as LlmobsClient;
}

/**
 * Next and tsx load `@anthropic-ai/sdk` as ESM, which only dd-trace's
 * loader hook can patch. `register.js` installs that hook and nothing
 * else; it must run before the SDK is first imported.
 */
async function loadDdTraceWithEsmHook(): Promise<DdTraceModule> {
  await import("dd-trace/register.js");
  return import("dd-trace");
}

/**
 * Init dd-trace LLM Observability only when a key is present and this is
 * a running server, never during `next build`. Every plugin but
 * `ENABLED_INTEGRATIONS` stays off (#42). The Anthropic hook patches the
 * SDK as it loads, so this must run before `@anthropic-ai/sdk` is first
 * imported: `instrumentation.ts` on the server, `evaluation/run.ts` in
 * eval. A failed init leaves requests untraced rather than failing them.
 */
export async function registerDatadogTracing(load: LoadDdTrace = loadDdTraceWithEsmHook): Promise<void> {
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
