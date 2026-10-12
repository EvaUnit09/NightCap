import "server-only";

import { costUsdFor } from "../models/pricing";
import { getModelFor } from "../models/router";
import { withStage } from "../monitoring/tracing";
import type { ValidationErrorCode } from "../validation/validation-error";
import type { ModelCallOutcome, ModelCallRecord, ModelFailureCode } from "./lifecycle";
import {
  modelErrorCodeOf,
  type ModelClient,
  type ModelErrorCode,
  type ModelResponse,
  type ModelStage,
} from "./model-client";
import { getPromptTraceTags, loadPrompt } from "./prompt-loader";

/** The span each model stage opens. */
const TRACE_STAGE_FOR = {
  parse_intent: "parse",
  plan_itineraries: "plan",
  repair_itinerary: "repair",
} as const satisfies Record<ModelStage, string>;

/** A Zod `safeParse` result, so any schema fits. */
export type BoundaryParse<T> = { success: true; data: T } | { success: false };

export interface ModelStageCall<T> {
  readonly stage: ModelStage;
  readonly promptVersion: string;
  readonly user: string;
  readonly maxTokens: number;
  /** The stage's Zod contract, applied to the JSON the model returned. */
  readonly parse: (json: unknown) => BoundaryParse<T>;
  /** Validation codes this call is asked to fix (repair only). */
  readonly outcomeCodes?: readonly ValidationErrorCode[];
  readonly signal?: AbortSignal;
}

/**
 * Thrown inside the span so it closes as an error with `code` (the reply's
 * failure, or the `ModelErrorCode` when there was no reply), then returned
 * as a value.
 */
class StageFailure extends Error {
  constructor(
    readonly failure: ModelFailureCode,
    readonly code: string,
    readonly record: ModelCallRecord,
  ) {
    super(code);
    this.name = "StageFailure";
  }
}

const FENCED_JSON = /```(?:json)?[^\n]*\n([\s\S]*?)```/;

/** The JSON value in a model reply: a fenced block if there is one, else the whole text. */
export function extractJson(text: string): unknown {
  const fenced = FENCED_JSON.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/** The JSON a reply holds, parsed against the stage's contract, or why it is unusable. */
export function readResponse<T>(
  response: ModelResponse,
  parse: (json: unknown) => BoundaryParse<T>,
): { ok: true; value: T } | { ok: false; code: ModelFailureCode } {
  if (response.stopReason === "refusal") {
    return { ok: false, code: "refusal" };
  }
  if (response.stopReason !== "end_turn") {
    return { ok: false, code: "truncated" };
  }
  const json = extractJson(response.text);
  if (json === undefined) {
    return { ok: false, code: "no_json" };
  }
  const parsed = parse(json);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, code: "schema_invalid" };
}

/**
 * One model call in its own span, tagged with prompt name and version,
 * model, tokens, and list-price cost. Every failure comes back as a value
 * with its call recorded; only an abort of `call.signal` throws.
 */
export async function callModelStage<T>(
  models: ModelClient,
  call: ModelStageCall<T>,
): Promise<ModelCallOutcome<T>> {
  const prompt = loadPrompt(call.stage, call.promptVersion);
  const model = getModelFor(call.stage);
  const target = { stage: call.stage, model, promptVersion: prompt.version };
  const errored = (errorCode: ModelErrorCode): ModelCallRecord => ({ kind: "errored", ...target, errorCode });
  try {
    const result = await withStage(
      {
        stage: TRACE_STAGE_FOR[call.stage],
        model,
        promptTags: getPromptTraceTags(prompt),
        outcomeCodes: call.outcomeCodes,
      },
      async (span) => {
        let response: ModelResponse;
        try {
          response = await models.complete({
            stage: call.stage,
            model,
            system: prompt.body,
            user: call.user,
            maxTokens: call.maxTokens,
            signal: call.signal,
          });
        } catch (error) {
          if (call.signal?.aborted) {
            throw error;
          }
          const errorCode = modelErrorCodeOf(error);
          throw new StageFailure("model_error", errorCode, errored(errorCode));
        }
        const costUsd = costUsdFor(model, response);
        span.record({ inputTokens: response.inputTokens, outputTokens: response.outputTokens, costUsd });
        const read = readResponse(response, call.parse);
        const record: ModelCallRecord = {
          kind: "replied",
          ...target,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          costUsd,
          formatValid: read.ok,
        };
        if (!read.ok) {
          throw new StageFailure(read.code, read.code, record);
        }
        return { value: read.value, record };
      },
    );
    return { kind: "parsed", value: result.value, call: result.record };
  } catch (error) {
    if (call.signal?.aborted) {
      throw error;
    }
    if (error instanceof StageFailure) {
      return { kind: "failed", code: error.failure, call: error.record };
    }
    return { kind: "failed", code: "model_error", call: errored("client_error") };
  }
}
