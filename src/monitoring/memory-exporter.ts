import "server-only";

import type {
  CapturedSpan,
  CapturedTrace,
  MemoryExporter,
  TraceSpan,
} from "./trace-types";

export function createMemoryExporter(): MemoryExporter {
  const traces: CapturedTrace[] = [];
  const stack: CapturedTrace[] = [];

  return {
    kind: "memory",
    get traces() {
      return traces;
    },
    async wrap<T>(span: TraceSpan, fn: () => Promise<T> | T): Promise<T> {
      const started = Date.now();
      if (stack.length === 0) {
        const trace: CapturedTrace = {
          name: span.name,
          attributes: { ...span.attributes },
          spans: [],
        };
        traces.push(trace);
        stack.push(trace);
        try {
          return await fn();
        } finally {
          trace.attributes.latency_ms = Date.now() - started;
          stack.pop();
        }
      }

      const child: CapturedSpan = {
        name: span.name,
        attributes: { ...span.attributes },
      };
      stack[stack.length - 1].spans.push(child);
      try {
        return await fn();
      } finally {
        child.attributes.latency_ms = Date.now() - started;
      }
    },
  };
}
