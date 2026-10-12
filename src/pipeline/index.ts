/**
 * Pipeline stage boundaries and the request orchestrator (build step 15).
 * Parse, plan, and repair all read these schemas.
 */
export {
  PARSE_MAX_TOKENS,
  PLAN_MAX_TOKENS,
  PROMPT_VERSIONS,
  createPipelineDeps,
  runPipeline,
  type PipelineDeps,
  type PipelineRequest,
} from "./orchestrator";
export type {
  DropReason,
  DroppedOption,
  InventedPlaceId,
  ModelCallOutcome,
  ModelCallRecord,
  ModelFailureCode,
  PipelineAudit,
  PipelineFailure,
  PipelineResult,
  RetrievalFailureCode,
  RetrievalGap,
  WorkingOption,
} from "./lifecycle";
export { admitOption, unknownPlaceIds, type AdmitResult, type EmittedOption } from "./emit-gate";
export type { ModelClient, ModelRequest, ModelResponse, ModelStage, ModelStopReason } from "./model-client";
export { createAnthropicModelClient } from "./anthropic-model-client";
export { REPAIR_MAX_TOKENS } from "./repair-loop";
export { extractJson } from "./stage-call";
export {
  MAX_TRAVEL_LEGS_PER_REQUEST_DEFAULT,
  STOPS_MAX,
  STOPS_MIN,
  STOPS_MIN_SINGLE,
  candidateSchema,
  intentSchema,
  itineraryOptionSchema,
  itineraryOptionSchemaFor,
  allowedShapes,
  itinerarySchema,
  itinerarySchemaFor,
  parseCandidate,
  parseIntent,
  parseItinerary,
  parseValidationError,
  singleStopMatchesIntent,
  stampSingleStopFromIntent,
  validationErrorSchema,
} from "../validation";

export {
  PIPELINE_STAGES,
  PROMPT_SCHEMA_BOUNDS,
  clearPromptCache,
  getPromptTraceTags,
  loadPrompt,
  type LoadPromptOptions,
  type PipelineStage,
  type PromptMetadata,
} from "./prompt-loader";

export { WRAP_USER_TEXT_MAX_CHARS, wrapUserText } from "./wrap-user-text";
