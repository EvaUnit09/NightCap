import "server-only";

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

export function spanKindFor(name: string): "workflow" | "llm" | "task" | "retrieval" {
  switch (name) {
    case "request":
      return "workflow";
    case "parse":
    case "plan":
    case "repair":
    case "agent":
      return "llm";
    case "places.search":
      return "retrieval";
    case "rerank":
    case "validate":
    case "stream":
      return "task";
    default:
      return "task";
  }
}
