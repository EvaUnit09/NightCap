import "server-only";

import type { Intent } from "../validation/intent";
import type { RedactionResult } from "./redact";
import type { ValidationErrorCode } from "../validation/validation-error";
import type { PROMPT_TAG_KEYS } from "./span-sanitize";
import type { TraceStage } from "./stages";

export type RequestHash = string & { readonly __brand: "RequestHash" };

export type ExporterKind = "noop" | "memory" | "datadog";

/**
 * Hand-made span kinds. `llm` spans come only from dd-trace's Anthropic
 * plugin, nested under the stage that made the call, so no stage is one.
 */
export type SpanKind = "workflow" | "task" | "retrieval" | "agent";

export type CacheHit = "hit" | "miss";

/**
 * The only intent fields a span may carry. Every free-text field
 * (`area`, `dietary`, `vibeTags`) is reduced to a count (#27).
 */
export interface SpanIntent {
  readonly budgetUsd: Intent["budgetUsd"];
  readonly stopTypes: Intent["stopTypes"];
  readonly singleStop: Intent["singleStop"];
  readonly window: Intent["window"];
  readonly dietaryCount: number;
  readonly vibeTagCount: number;
}

export type SpanIntentSummary = SpanIntent | { readonly valid: false };

export type PromptTags = Readonly<Partial<Record<(typeof PROMPT_TAG_KEYS)[number], string>>>;

/**
 * The span attribute model is a closed allowlist. Every string is an enum,
 * our own hash, or a value that passed `isSafeTagValue`.
 */
export type RootSpanAttributes = {
  readonly request_hash: RequestHash;
  readonly parsed_intent?: SpanIntentSummary;
  readonly test_case_id?: string;
};

export type StageSpanAttributes = PromptTags & {
  readonly stage: TraceStage;
  readonly request_hash: RequestHash;
  readonly model?: string;
  readonly cache?: CacheHit;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cost_usd?: number;
  readonly outcome_codes?: string;
  readonly test_case_id?: string;
};

export type SpanAttributes = RootSpanAttributes | StageSpanAttributes;

/** What a caller may say about a stage. `stageAttributes` turns it into span attributes. */
export interface StageAttrs {
  readonly stage: TraceStage;
  readonly model?: string;
  readonly promptTags?: PromptTags;
  readonly cache?: CacheHit;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  readonly outcomeCodes?: readonly ValidationErrorCode[];
  readonly testCaseId?: string;
}

/** Measurements known only after a stage's work finishes (#10: tokens, cost, errors by type). */
export type StageMeasures = Pick<
  StageAttrs,
  "model" | "promptTags" | "inputTokens" | "outputTokens" | "costUsd" | "outcomeCodes"
>;

/** Handed to a `withStage` callback. Each call merges over earlier ones and passes the same allowlist. */
export interface StageRecorder {
  record(measures: StageMeasures): void;
}

/** A successful `redact` result. Taking the result, not a string, keeps raw request text out of the trace input. */
export type RedactedRequest = Extract<RedactionResult, { ok: true }>;

/** What the request's workflow span shows as its output: the emitted venues, or where it stopped. */
export type RequestOutput =
  | {
      readonly status: "completed";
      readonly options: readonly {
        readonly stops: readonly { readonly placeId: string; readonly name: string }[];
      }[];
    }
  | { readonly status: "failed"; readonly stage: string; readonly code: string };

/**
 * Free text a span may carry (#42). It goes only to LLM Obs input and
 * output, never to tags or metadata.
 */
export interface SpanIO {
  readonly input?: string;
  readonly output?: RequestOutput;
}

/** Prompt Tracking identity for the `llm` spans a stage's model call opens. */
export interface LlmPrompt {
  readonly id: string;
  readonly version: string;
  readonly tags?: Readonly<Record<string, string>>;
}

/** Handed to a `withRequestTrace` callback so the root span carries the parsed intent once parse runs. */
export interface RequestRecorder {
  recordParsedIntent(intent: unknown): void;
  recordInput(redacted: RedactedRequest): void;
  recordOutput(output: RequestOutput): void;
}

export interface RequestTraceInput {
  readonly requestText: string;
  readonly parsedIntent?: unknown;
  readonly testCaseId?: string;
  /** Test-only. Production callers omit this and use `createExporter()`. */
  readonly exporter?: TraceExporter;
}

export interface CapturedSpan {
  readonly name: string;
  readonly kind: SpanKind;
  readonly attributes: Record<string, unknown>;
  readonly prompt?: LlmPrompt;
}

export interface CapturedTrace {
  readonly name: string;
  readonly attributes: Record<string, unknown>;
  readonly spans: CapturedSpan[];
  io: SpanIO;
}

export interface TraceSpan {
  readonly name: string;
  readonly kind: SpanKind;
  /** Attributes known when the span opens. */
  readonly attributes: SpanAttributes;
  /** Attributes after the work ran, read once as the span closes. Already sanitized. */
  readonly resolveAttributes?: () => SpanAttributes;
  /** Input and output after the work ran, read once as the span closes. */
  readonly resolveIO?: () => SpanIO;
  /** Applied to every `llm` span opened inside this one. */
  readonly prompt?: LlmPrompt;
}

export interface TraceExporter {
  readonly kind: ExporterKind;
  wrap<T>(span: TraceSpan, fn: () => Promise<T> | T): Promise<T>;
}

export interface MemoryExporter extends TraceExporter {
  readonly kind: "memory";
  readonly traces: readonly CapturedTrace[];
}
