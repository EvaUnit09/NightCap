/**
 * Monitoring module for NightCap.
 *
 * Server-only: the given-name list must not reach a client bundle.
 * Callers must check `result.ok` and must never forward `{ ok: false }`
 * text to a model. Datadog spans get parsed_intent plus a hash, not this
 * free text — use `redact` / `redactForStorage` before a database write.
 */
import "server-only";

export {
  GIVEN_NAME_COUNT,
  MAX_INPUT_CHARS,
  redact,
  redactForStorage,
  redactValue,
} from "./redact";
export type { RedactionCounts, RedactionErrorCode, RedactionResult } from "./redact";
