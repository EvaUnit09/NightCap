import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import { getOptionalDdApiKey } from "../models/config";
import { createDatadogExporter } from "./datadog-exporter";
import { createMemoryExporter } from "./memory-exporter";
import { createNoopExporter } from "./noop-exporter";
import { hashRequest } from "./request-hash";
import { rootAttributes, stageAttributes } from "./span-sanitize";
import { isTraceStage, spanKindFor } from "./stages";
import type {
  MemoryExporter,
  RequestTraceInput,
  StageAttrs,
  TraceExporter,
} from "./trace-types";

interface TraceContext {
  readonly exporter: TraceExporter;
  readonly requestHash: ReturnType<typeof hashRequest>;
  readonly requestText: string;
}

const storage = new AsyncLocalStorage<TraceContext>();

export function createExporter(): TraceExporter {
  if (getOptionalDdApiKey()) {
    return createDatadogExporter();
  }
  return createNoopExporter();
}

export { createMemoryExporter };

export async function withRequestTrace<T>(
  input: RequestTraceInput,
  fn: () => Promise<T> | T,
): Promise<T> {
  const exporter = input.exporter ?? createExporter();
  const requestHash = hashRequest(input.requestText);
  const attributes = rootAttributes(input, requestHash);
  const ctx: TraceContext = {
    exporter,
    requestHash,
    requestText: input.requestText,
  };
  return storage.run(ctx, () =>
    exporter.wrap(
      {
        name: "request",
        kind: spanKindFor("request"),
        attributes,
      },
      fn,
    ),
  );
}

export async function withStage<T>(
  attrs: StageAttrs,
  fn: () => Promise<T> | T,
): Promise<T> {
  const ctx = storage.getStore();
  if (!ctx || !isTraceStage(attrs.stage)) {
    return await fn();
  }
  const attributes = stageAttributes(attrs, ctx.requestHash, ctx.requestText);
  return ctx.exporter.wrap(
    {
      name: attrs.stage,
      kind: spanKindFor(attrs.stage),
      attributes,
    },
    fn,
  );
}

export type { MemoryExporter, RequestTraceInput, StageAttrs, TraceExporter };
