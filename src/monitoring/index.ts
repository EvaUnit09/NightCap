/**
 * Monitoring module for NightCap.
 *
 * Server-only: the given-name list and the tracing SDK must not reach a
 * client bundle. Callers must check `result.ok` and must never forward
 * `{ ok: false }` text to a model. Datadog spans get an allowlisted parsed_intent
 * summary plus a hash, not this free text. `prepareStoredRequest` is the only
 * boundary that may produce a row for `insertStoredRequest`.
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

export { hashRequest } from "./request-hash";
export { insertStoredRequest, prepareStoredRequest } from "./store-request";
export type { PrepareStoredRequestResult, Queryable, StoredRequest } from "./store-request";
export { TRACE_STAGES, isTraceStage, spanKindFor } from "./stages";
export type { TraceStage } from "./stages";
export { registerDatadogTracing } from "./datadog-exporter";
export {
  createExporter,
  createMemoryExporter,
  withRequestTrace,
  withStage,
} from "./tracing";
export type {
  CapturedSpan,
  CapturedTrace,
  ExporterKind,
  MemoryExporter,
  RequestHash,
  RequestTraceInput,
  StageAttrs,
  TraceExporter,
} from "./trace-types";
