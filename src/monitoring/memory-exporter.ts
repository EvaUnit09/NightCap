import "server-only";

import { safeErrorCode } from "./datadog-exporter";
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
          io: {},
        };
        traces.push(trace);
        stack.push(trace);
        try {
          return await fn();
        } finally {
          Object.assign(trace.attributes, span.resolveAttributes?.());
          trace.io = span.resolveIO?.() ?? {};
          trace.attributes.latency_ms = Date.now() - started;
          stack.pop();
        }
      }

      const child: CapturedSpan = {
        name: span.name,
        kind: span.kind,
        attributes: { ...span.attributes },
        prompt: span.prompt,
      };
      stack[stack.length - 1].spans.push(child);
      try {
        const result = await fn();
        child.attributes.status = "ok";
        return result;
      } catch (error) {
        // Same outcome tags the Datadog exporter sends, so tests can assert them.
        child.attributes.status = "error";
        child.attributes.error_code = safeErrorCode(error);
        throw error;
      } finally {
        Object.assign(child.attributes, span.resolveAttributes?.());
        child.attributes.latency_ms = Date.now() - started;
      }
    },
  };
}
