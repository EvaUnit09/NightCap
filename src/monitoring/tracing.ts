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
  RequestRecorder,
  RequestTraceInput,
  StageAttrs,
  StageMeasures,
  StageRecorder,
  TraceExporter,
} from "./trace-types";

interface TraceContext {
  readonly exporter: TraceExporter;
  readonly requestHash: ReturnType<typeof hashRequest>;
  readonly requestText: string;
  readonly testCaseId?: string;
}

const storage = new AsyncLocalStorage<TraceContext>();

const NOOP_STAGE_RECORDER: StageRecorder = { record: () => undefined };

export function createExporter(): TraceExporter {
  if (getOptionalDdApiKey()) {
    return createDatadogExporter();
  }
  return createNoopExporter();
}

export { createMemoryExporter };

/**
 * One trace per request. `fn` may record the parsed intent once parse
 * runs; the root span then carries the allowlisted summary, never free text.
 */
export async function withRequestTrace<T>(
  input: RequestTraceInput,
  fn: (request: RequestRecorder) => Promise<T> | T,
): Promise<T> {
  const exporter = input.exporter ?? createExporter();
  const requestHash = hashRequest(input.requestText);
  let parsedIntent = input.parsedIntent;
  const recorder: RequestRecorder = {
    recordParsedIntent: (intent) => {
      parsedIntent = intent;
    },
  };
  const ctx: TraceContext = {
    exporter,
    requestHash,
    requestText: input.requestText,
    testCaseId: input.testCaseId,
  };
  return storage.run(ctx, () =>
    exporter.wrap(
      {
        name: "request",
        kind: spanKindFor("request"),
        attributes: rootAttributes(input, requestHash),
        resolveAttributes: () => rootAttributes({ ...input, parsedIntent }, requestHash),
      },
      () => fn(recorder),
    ),
  );
}

/**
 * One child span. `fn` may record tokens, cost, model, prompt tags, and
 * validation codes after its work; they pass the same allowlist as `attrs`.
 * Outside a request trace this just runs `fn`.
 */
export async function withStage<T>(
  attrs: StageAttrs,
  fn: (span: StageRecorder) => Promise<T> | T,
): Promise<T> {
  const ctx = storage.getStore();
  if (!ctx || !isTraceStage(attrs.stage)) {
    return await fn(NOOP_STAGE_RECORDER);
  }
  const opened: StageAttrs = { testCaseId: ctx.testCaseId, ...attrs };
  let measured: StageMeasures = {};
  const recorder: StageRecorder = {
    record: (measures) => {
      measured = { ...measured, ...measures };
    },
  };
  const sanitize = (value: StageAttrs) => stageAttributes(value, ctx.requestHash, ctx.requestText);
  return ctx.exporter.wrap(
    {
      name: attrs.stage,
      kind: spanKindFor(attrs.stage),
      attributes: sanitize(opened),
      resolveAttributes: () => sanitize({ ...opened, ...measured }),
    },
    () => fn(recorder),
  );
}

export type {
  MemoryExporter,
  RequestRecorder,
  RequestTraceInput,
  StageAttrs,
  StageMeasures,
  StageRecorder,
  TraceExporter,
};
