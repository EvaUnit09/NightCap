import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import { getOptionalDdApiKey } from "../models/config";
import { createDatadogExporter } from "./datadog-exporter";
import { publishRequestOutcome } from "./datadog-metrics";
import { createMemoryExporter } from "./memory-exporter";
import { createNoopExporter } from "./noop-exporter";
import { hashRequest } from "./request-hash";
import { rootAttributes, stageAttributes, stagePrompt } from "./span-sanitize";
import { isTraceStage, spanKindFor } from "./stages";
import type {
  MemoryExporter,
  RequestOutput,
  RequestRecorder,
  RequestTraceInput,
  SpanIO,
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
 * runs; the root span then carries the allowlisted summary as metadata.
 * The redacted request and the emitted venues it records are the span's
 * LLM Obs input and output, the only place free text goes (#42).
 */
export async function withRequestTrace<T>(
  input: RequestTraceInput,
  fn: (request: RequestRecorder) => Promise<T> | T,
): Promise<T> {
  const exporter = input.exporter ?? createExporter();
  const requestHash = hashRequest(input.requestText);
  let parsedIntent = input.parsedIntent;
  let io: SpanIO = {};
  const recorder: RequestRecorder = {
    recordParsedIntent: (intent) => {
      parsedIntent = intent;
    },
    recordInput: (redacted) => {
      io = { ...io, input: redacted.text };
    },
    recordOutput: (output) => {
      io = { ...io, output };
    },
  };
  const ctx: TraceContext = {
    exporter,
    requestHash,
    requestText: input.requestText,
    testCaseId: input.testCaseId,
  };
  const source = input.testCaseId === undefined ? "app" : "eval";
  try {
    const result = await storage.run(ctx, () =>
      exporter.wrap(
        {
          name: "request",
          kind: spanKindFor("request"),
          attributes: rootAttributes(input, requestHash),
          resolveAttributes: () => rootAttributes({ ...input, parsedIntent }, requestHash),
          resolveIO: () => io,
        },
        () => fn(recorder),
      ),
    );
    // A typed pipeline failure returns { status: "failed" } and does not throw,
    // so the span tag stays ok. The error count has to read that output.
    publishRequestOutcome({ thrown: false, output: io.output, source });
    return result;
  } catch (error) {
    publishRequestOutcome({ thrown: true, output: io.output, source });
    throw error;
  }
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
  const attributes = sanitize(opened);
  return ctx.exporter.wrap(
    {
      name: attrs.stage,
      kind: spanKindFor(attrs.stage),
      attributes,
      prompt: stagePrompt(attributes),
      resolveAttributes: () => sanitize({ ...opened, ...measured }),
    },
    () => fn(recorder),
  );
}

export type {
  MemoryExporter,
  RequestOutput,
  RequestRecorder,
  RequestTraceInput,
  StageAttrs,
  StageMeasures,
  StageRecorder,
  TraceExporter,
};
