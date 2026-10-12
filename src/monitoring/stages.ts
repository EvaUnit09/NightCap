import "server-only";

import type { SpanKind } from "./trace-types";

/**
 * Pipeline and retrieval stages that open a child span.
 * Names match architecture.md observability (`parse`, `places.search`, …).
 */
export const TRACE_STAGES = [
  "parse",
  "places.search",
  "rerank",
  "plan",
  "validate",
  "repair",
  "stream",
  "agent",
] as const;

export type TraceStage = (typeof TRACE_STAGES)[number];

export function isTraceStage(value: string): value is TraceStage {
  return (TRACE_STAGES as readonly string[]).includes(value);
}

/** Model stages are `task` spans; the Anthropic plugin's `llm` span nests under each call. */
export function spanKindFor(name: string): SpanKind {
  switch (name) {
    case "request":
      return "workflow";
    case "places.search":
      return "retrieval";
    case "agent":
      return "agent";
    default:
      return "task";
  }
}
