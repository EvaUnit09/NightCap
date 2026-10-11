import "server-only";

import type { TraceExporter, TraceSpan } from "./trace-types";

export function createNoopExporter(): TraceExporter {
  return {
    kind: "noop",
    async wrap<T>(_span: TraceSpan, fn: () => Promise<T> | T): Promise<T> {
      return await fn();
    },
  };
}
