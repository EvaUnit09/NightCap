import "server-only";

import { getOptionalDdApiKey } from "../models/config";
import type { SpanKind, TraceExporter, TraceSpan } from "./trace-types";

type LlmobsAnnotate = {
  annotate(
    span: unknown,
    options: {
      tags?: Record<string, string>;
      metadata?: Record<string, unknown>;
      metrics?: Record<string, number>;
    },
  ): void;
  trace<T>(
    options: { name: string; kind: SpanKind },
    fn: (span: unknown) => T | Promise<T>,
  ): T | Promise<T>;
};

let llmobs: LlmobsAnnotate | null = null;
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
    if (value === undefined || value === null) continue;
    if (key === "parsed_intent") continue;
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
  llmobs = tracer.llmobs as unknown as LlmobsAnnotate;
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
      const active = llmobs;
      if (!active) {
        return await fn();
      }
      const started = Date.now();
      return await Promise.resolve(
        active.trace({ name: span.name, kind: span.kind }, async (ddSpan) => {
          const attributes = { ...span.attributes };
          try {
            const result = await fn();
            attributes.latency_ms = Date.now() - started;
            active.annotate(ddSpan, {
              tags: flattenTags(attributes),
              metadata:
                attributes.parsed_intent !== undefined
                  ? { parsed_intent: attributes.parsed_intent }
                  : undefined,
              metrics: metricsFrom(attributes),
            });
            return result;
          } catch (error) {
            attributes.latency_ms = Date.now() - started;
            active.annotate(ddSpan, {
              tags: flattenTags(attributes),
              metadata:
                attributes.parsed_intent !== undefined
                  ? { parsed_intent: attributes.parsed_intent }
                  : undefined,
              metrics: metricsFrom(attributes),
            });
            throw error;
          }
        }),
      );
    },
  };
}
