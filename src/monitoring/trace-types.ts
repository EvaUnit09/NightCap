import "server-only";

import type { TraceStage } from "./stages";

export type RequestHash = string & { readonly __brand: "RequestHash" };

export type ExporterKind = "noop" | "memory" | "datadog";

export type SpanKind = "workflow" | "llm" | "task" | "retrieval";

export type CacheHit = "hit" | "miss";

/**
 * Tags a stage span may carry. Closed set: callers cannot pass `user_text`.
 * `parsed_intent` belongs on the request root, not here.
 */
export interface StageAttrs {
  readonly stage: TraceStage;
  readonly model?: string;
  readonly promptTags?: Readonly<Record<string, string>>;
  readonly cache?: CacheHit;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  readonly outcomeCodes?: readonly string[];
  readonly testCaseId?: string;
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
  readonly attributes: Record<string, unknown>;
}

export interface CapturedTrace {
  readonly name: string;
  readonly attributes: Record<string, unknown>;
  readonly spans: CapturedSpan[];
}

export interface TraceSpan {
  readonly name: string;
  readonly kind: SpanKind;
  readonly attributes: Record<string, unknown>;
}

export interface TraceExporter {
  readonly kind: ExporterKind;
  wrap<T>(span: TraceSpan, fn: () => Promise<T> | T): Promise<T>;
}

export interface MemoryExporter extends TraceExporter {
  readonly kind: "memory";
  readonly traces: readonly CapturedTrace[];
}
