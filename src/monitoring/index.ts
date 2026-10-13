/**
 * Monitoring module for NightCap.
 *
 * Server-only: the given-name list and the tracing SDK must not reach a
 * client bundle. Callers must check `result.ok` and must never forward
 * `{ ok: false }` text to a model. Datadog span attributes get an allowlisted
 * parsed_intent summary plus a hash; the redacted text is only the workflow
 * span's LLM Obs input (#42). `prepareStoredRequest` is the only
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
export { createPlanPersistence, modelsFromCalls, savePlan } from "./persist-plan";
export type { PlanPersistence, PlanSaveInput, SavedPlan } from "./persist-plan";
export { hydrateItinerary, loadStoredItinerary } from "./hydrate-plan";
export type { HydratedStop, PlaceDetailsLookup, PlaceLiveDetails, StoredItinerary } from "./hydrate-plan";
export { stripStopForStorage } from "./stored-stop";
export type { StoredStop } from "./stored-stop";
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
  LlmPrompt,
  MemoryExporter,
  RedactedRequest,
  RequestHash,
  RequestOutput,
  RequestRecorder,
  RequestTraceInput,
  StageAttrs,
  StageMeasures,
  StageRecorder,
  TraceExporter,
} from "./trace-types";
