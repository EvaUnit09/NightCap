import "server-only";

import { intentSchema } from "../validation/intent";
import type { RequestHash, SpanIntentSummary } from "./trace-types";
import type { StageAttrs } from "./trace-types";

const FORBIDDEN_KEYS = new Set([
  "user_text",
  "request",
  "request_text",
  "redacted_text",
  "raw_request",
  "prompt_body",
  "input_data",
  "output_data",
  "messages",
  "people",
]);

const PROMPT_TAG_KEYS = [
  "prompt_name",
  "prompt_version",
  "prompt_hash",
  "prompt_rendered_hash",
] as const;

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

export function rootAttributes(input: {
  requestHash: RequestHash;
  parsedIntent?: unknown;
  testCaseId?: string;
}): Record<string, unknown> {
  const attributes: Record<string, unknown> = {
    request_hash: input.requestHash,
  };
  if (input.parsedIntent !== undefined) {
    attributes.parsed_intent = summarizeIntent(input.parsedIntent);
  }
  if (input.testCaseId !== undefined) {
    attributes.test_case_id = input.testCaseId;
  }
  return stripForbidden(attributes, undefined);
}

export function stageAttributes(
  attrs: StageAttrs,
  requestHash: RequestHash | undefined,
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {
    stage: attrs.stage,
  };
  if (requestHash !== undefined) {
    attributes.request_hash = requestHash;
  }
  if (attrs.model !== undefined) {
    attributes.model = attrs.model;
  }
  if (attrs.cache !== undefined) {
    attributes.cache = attrs.cache;
  }
  if (attrs.inputTokens !== undefined) {
    attributes.input_tokens = attrs.inputTokens;
  }
  if (attrs.outputTokens !== undefined) {
    attributes.output_tokens = attrs.outputTokens;
  }
  if (attrs.costUsd !== undefined) {
    attributes.cost_usd = attrs.costUsd;
  }
  if (attrs.outcomeCodes !== undefined) {
    attributes.outcome_codes = attrs.outcomeCodes.join(",");
  }
  if (attrs.testCaseId !== undefined) {
    attributes.test_case_id = attrs.testCaseId;
  }
  if (attrs.promptTags) {
    for (const key of PROMPT_TAG_KEYS) {
      const value = attrs.promptTags[key];
      if (value !== undefined) {
        attributes[key] = value;
      }
    }
  }
  return stripForbidden(attributes, undefined);
}

/**
 * Drop keys that must never leave this process, and replace any string
 * that equals the raw request so a mistaken caller cannot leak it.
 */
export function stripForbidden(
  value: Record<string, unknown>,
  rawRequest: string | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      continue;
    }
    out[key] = scrubValue(nested, rawRequest);
  }
  return out;
}

function scrubValue(value: unknown, rawRequest: string | undefined): unknown {
  if (typeof value === "string") {
    if (rawRequest && value === rawRequest) {
      return "[REDACTED]";
    }
    return value;
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, rawRequest));
  }
  return stripForbidden(value as Record<string, unknown>, rawRequest);
}
