/**
 * Monitoring module for NightCap.
 *
 * Provides PII redaction. Callers must check `result.ok` and must never
 * forward `{ ok: false }` text to a model.
 */

export {
  GIVEN_NAME_COUNT,
  MAX_INPUT_CHARS,
  redact,
  redactForStorage,
  redactForTrace,
  redactTextUncapped,
  redactValue,
} from "./redact";
export type { RedactionCounts, RedactionErrorCode, RedactionResult } from "./redact";
