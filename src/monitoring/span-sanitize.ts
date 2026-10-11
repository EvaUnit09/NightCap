import "server-only";

import { intentSchema } from "../validation/intent";
import { validationErrorCodeSchema } from "../validation/validation-error";
import type { ValidationErrorCode } from "../validation/validation-error";
import type {
  CacheHit,
  PromptTags,
  RequestHash,
  RequestTraceInput,
  RootSpanAttributes,
  SpanIntentSummary,
  StageAttrs,
  StageSpanAttributes,
} from "./trace-types";

const SAFE_TAG_VALUE = /^[A-Za-z0-9._:\/-]{1,128}$/;

export const PROMPT_TAG_KEYS = [
  "prompt_name",
  "prompt_version",
  "prompt_hash",
  "prompt_rendered_hash",
] as const;

export function isSafeTagValue(value: unknown): value is string {
  return typeof value === "string" && SAFE_TAG_VALUE.test(value);
}

/**
 * A single-token request passes `isSafeTagValue`, so a caller that passes
 * the request itself as a tag is caught by equality instead.
 */
function safeTag(value: string | undefined, rawRequest: string): string | undefined {
  return isSafeTagValue(value) && value !== rawRequest ? value : undefined;
}

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cacheHit(value: CacheHit | undefined): CacheHit | undefined {
  return value === "hit" || value === "miss" ? value : undefined;
}

function outcomeCodesTag(codes: readonly ValidationErrorCode[] | undefined): string | undefined {
  if (!Array.isArray(codes)) {
    return undefined;
  }
  const valid = codes.filter((code) => validationErrorCodeSchema.safeParse(code).success);
  return valid.length > 0 ? valid.join(",") : undefined;
}

function promptTagAttributes(tags: PromptTags | undefined, rawRequest: string): PromptTags {
  if (!tags) {
    return {};
  }
  return Object.fromEntries(
    PROMPT_TAG_KEYS.map((key) => [key, safeTag(tags[key], rawRequest)]),
  ) as PromptTags;
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

export function summarizeIntent(intent: unknown): SpanIntentSummary {
  const parsed = intentSchema.safeParse(intent);
  if (!parsed.success) {
    return { valid: false };
  }
  const { budgetUsd, stopTypes, singleStop, window, dietary, vibeTags } = parsed.data;
  return {
    budgetUsd,
    stopTypes,
    singleStop,
    window: { start: window.start, end: window.end },
    dietaryCount: dietary.length,
    vibeTagCount: vibeTags.length,
  };
}

export function rootAttributes(
  input: RequestTraceInput,
  requestHash: RequestHash,
): RootSpanAttributes {
  return withoutUndefined({
    request_hash: requestHash,
    parsed_intent:
      input.parsedIntent === undefined ? undefined : summarizeIntent(input.parsedIntent),
    test_case_id: safeTag(input.testCaseId, input.requestText),
  });
}

export function stageAttributes(
  attrs: StageAttrs,
  requestHash: RequestHash,
  rawRequest: string,
): StageSpanAttributes {
  return withoutUndefined({
    stage: attrs.stage,
    request_hash: requestHash,
    model: safeTag(attrs.model, rawRequest),
    cache: cacheHit(attrs.cache),
    input_tokens: finiteNumber(attrs.inputTokens),
    output_tokens: finiteNumber(attrs.outputTokens),
    cost_usd: finiteNumber(attrs.costUsd),
    outcome_codes: outcomeCodesTag(attrs.outcomeCodes),
    test_case_id: safeTag(attrs.testCaseId, rawRequest),
    ...promptTagAttributes(attrs.promptTags, rawRequest),
  });
}
