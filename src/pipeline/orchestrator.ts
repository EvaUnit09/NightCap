import "server-only";

import { getMaxTravelLegsPerRequest, getRepairMaxRounds } from "../models/config";
import { redact } from "../monitoring/redact";
import { withRequestTrace } from "../monitoring/tracing";
import type { RequestRecorder, TraceExporter } from "../monitoring/trace-types";
import { allCandidates, retrieveForIntent, type Retrieval } from "../retrieval";
import type { Candidate } from "../validation/candidate";
import { normalizeModelTravelModes } from "../validation/common";
import { intentSchema, type Intent } from "../validation/intent";
import { itinerarySchemaFor, type Itinerary } from "../validation/itinerary";
import { stampSingleStopFromIntent } from "../validation/single-stop";
import type { ValidatorInput } from "../validation/validator";
import { validateItineraryServer } from "../validation/validator-server";
import type { ValidationError } from "../validation/validation-error";
import { createAnthropicModelClient } from "./anthropic-model-client";
import { unknownPlaceIds } from "./emit-gate";
import type {
  DroppedOption,
  InventedPlaceId,
  ModelCallRecord,
  PipelineAudit,
  PipelineFailure,
  PipelineResult,
  RetrievalGap,
} from "./lifecycle";
import type { ModelClient, ModelStage } from "./model-client";
import { validateAndRepair } from "./repair-loop";
import { callModelStage } from "./stage-call";
import { parseMessage, planMessage } from "./stage-messages";

export const PARSE_MAX_TOKENS = 2_000;
export const PLAN_MAX_TOKENS = 16_000;

/** Prompt version per model stage. A new prompt version is a change here plus a new file. */
export const PROMPT_VERSIONS: Readonly<Record<ModelStage, string>> = {
  parse_intent: "v1",
  plan_itineraries: "v1",
  repair_itinerary: "v1",
};

export interface PipelineDeps {
  readonly models: ModelClient;
  /** Retrieval for one parsed intent. The server passes `retrieveForIntent`. */
  readonly retrieve: (intent: Intent, signal?: AbortSignal) => Promise<Retrieval>;
  /** `validateItinerary` with its options bound. The server passes `validateItineraryServer`. */
  readonly validate: (input: ValidatorInput) => Promise<ValidationError[]>;
  readonly repairMaxRounds: number;
  readonly maxLegs: number;
  readonly promptVersions: Readonly<Record<ModelStage, string>>;
  /** Test-only. Production omits this and the trace picks its exporter from config. */
  readonly exporter?: TraceExporter;
}

export interface PipelineRequest {
  /** The user's free text, before redaction. Only its HMAC reaches a span. */
  readonly text: string;
  readonly testCaseId?: string;
  readonly signal?: AbortSignal;
}

/** Deps from config: the Anthropic client, live retrieval, and the config-bound validator. */
export function createPipelineDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    models: createAnthropicModelClient(),
    retrieve: (intent, signal) => retrieveForIntent(intent, signal),
    validate: (input) => validateItineraryServer(input),
    repairMaxRounds: getRepairMaxRounds(),
    maxLegs: getMaxTravelLegsPerRequest(),
    promptVersions: PROMPT_VERSIONS,
    ...overrides,
  };
}

/** Everything known so far, so a failure at any stage still reports cost and calls. */
interface Progress {
  readonly intent: Intent | null;
  readonly modelCalls: readonly ModelCallRecord[];
  readonly candidates: readonly Candidate[];
  readonly gaps: readonly RetrievalGap[];
  readonly plannedOptionCount: number;
  readonly inventedPlaceIds: readonly InventedPlaceId[];
  readonly repairRoundsRun: number;
  readonly dropped: readonly DroppedOption[];
}

const START: Progress = {
  intent: null,
  modelCalls: [],
  candidates: [],
  gaps: [],
  plannedOptionCount: 0,
  inventedPlaceIds: [],
  repairRoundsRun: 0,
  dropped: [],
};

function audit(progress: Progress): PipelineAudit {
  return {
    modelCalls: progress.modelCalls,
    candidateCount: progress.candidates.length,
    plannedOptionCount: progress.plannedOptionCount,
    inventedPlaceIds: progress.inventedPlaceIds,
    repairRoundsRun: progress.repairRoundsRun,
    totalCostUsd: progress.modelCalls.reduce((total, call) => total + (call.costUsd ?? 0), 0),
  };
}

function failed(failure: PipelineFailure, progress: Progress): PipelineResult {
  return {
    kind: "failed",
    failure,
    intent: progress.intent,
    dropped: progress.dropped,
    retrievalGaps: progress.gaps,
    audit: audit(progress),
  };
}

function withCall(progress: Progress, call: ModelCallRecord | null): Progress {
  return call === null ? progress : { ...progress, modelCalls: [...progress.modelCalls, call] };
}

function gapsOf(retrieval: Retrieval): RetrievalGap[] {
  return [...retrieval.byStopType].flatMap(([stopType, outcome]) =>
    outcome.kind === "gap" ? [{ stopType, reason: outcome.reason }] : [],
  );
}

function parsePlan(json: unknown, intent: Intent, maxLegs: number) {
  const stamped = typeof json === "object" && json !== null ? stampSingleStopFromIntent(json, intent.singleStop) : json;
  return itinerarySchemaFor({ maxLegs }).safeParse(normalizeModelTravelModes(stamped));
}

function plannedInventions(plan: Itinerary, candidates: readonly Candidate[]): InventedPlaceId[] {
  const candidateIds = new Set(candidates.map((candidate) => candidate.placeId));
  return plan.options.flatMap((option, optionIndex) =>
    unknownPlaceIds(option, candidateIds).map((placeId) => ({ stage: "plan" as const, round: 0, optionIndex, placeId })),
  );
}

async function retrieveStage(
  deps: PipelineDeps,
  intent: Intent,
  signal: AbortSignal | undefined,
): Promise<{ ok: true; retrieval: Retrieval } | { ok: false }> {
  try {
    return { ok: true, retrieval: await deps.retrieve(intent, signal) };
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    return { ok: false };
  }
}

async function parseStage(deps: PipelineDeps, request: PipelineRequest, trace: RequestRecorder, progress: Progress) {
  const redacted = redact(request.text);
  if (!redacted.ok) {
    return { kind: "ended", result: failed({ stage: "redact", code: redacted.error }, progress) } as const;
  }
  const parsed = await callModelStage(deps.models, {
    stage: "parse_intent",
    promptVersion: deps.promptVersions.parse_intent,
    user: parseMessage(redacted.text),
    maxTokens: PARSE_MAX_TOKENS,
    parse: (json) => intentSchema.safeParse(json),
    signal: request.signal,
  });
  const next = withCall(progress, parsed.call);
  if (parsed.kind === "failed") {
    return { kind: "ended", result: failed({ stage: "parse", code: parsed.code }, next) } as const;
  }
  trace.recordParsedIntent(parsed.value);
  return { kind: "parsed", intent: parsed.value, progress: { ...next, intent: parsed.value } } as const;
}

async function planAndRepair(
  deps: PipelineDeps,
  request: PipelineRequest,
  intent: Intent,
  progress: Progress,
): Promise<PipelineResult> {
  const { candidates } = progress;
  const plan = await callModelStage(deps.models, {
    stage: "plan_itineraries",
    promptVersion: deps.promptVersions.plan_itineraries,
    user: planMessage(intent, candidates),
    maxTokens: PLAN_MAX_TOKENS,
    parse: (json) => parsePlan(json, intent, deps.maxLegs),
    signal: request.signal,
  });
  const planned = withCall(progress, plan.call);
  if (plan.kind === "failed") {
    return failed({ stage: "plan", code: plan.code }, planned);
  }
  const loop = await validateAndRepair(
    {
      models: deps.models,
      validate: deps.validate,
      repairMaxRounds: deps.repairMaxRounds,
      repairPromptVersion: deps.promptVersions.repair_itinerary,
    },
    { intent, candidates, planned: plan.value.options, signal: request.signal },
  );
  const settled: Progress = {
    ...planned,
    modelCalls: [...planned.modelCalls, ...loop.modelCalls],
    plannedOptionCount: plan.value.options.length,
    inventedPlaceIds: [...plannedInventions(plan.value, candidates), ...loop.inventedPlaceIds],
    repairRoundsRun: loop.roundsRun,
    dropped: loop.dropped,
  };
  const [first, ...rest] = loop.emitted;
  if (first === undefined) {
    return failed({ stage: "validate", code: "no_valid_options" }, settled);
  }
  return {
    kind: "completed",
    intent,
    options: [first, ...rest],
    dropped: settled.dropped,
    retrievalGaps: settled.gaps,
    audit: audit(settled),
  };
}

async function runStages(deps: PipelineDeps, request: PipelineRequest, trace: RequestRecorder): Promise<PipelineResult> {
  const parsed = await parseStage(deps, request, trace, START);
  if (parsed.kind === "ended") {
    return parsed.result;
  }
  const { intent } = parsed;
  const retrieved = await retrieveStage(deps, intent, request.signal);
  if (!retrieved.ok) {
    return failed({ stage: "retrieve", code: "retrieval_error" }, parsed.progress);
  }
  const progress: Progress = {
    ...parsed.progress,
    candidates: allCandidates(retrieved.retrieval),
    gaps: gapsOf(retrieved.retrieval),
  };
  if (progress.candidates.length === 0) {
    return failed({ stage: "retrieve", code: "no_candidates" }, progress);
  }
  return planAndRepair(deps, request, intent, progress);
}

/**
 * Build step 15: redact → parse → retrieve → plan → validate ⇄ repair, in
 * one request trace. Venues come only from this request's retrieval: the
 * planner and repairer see only those candidates, `validateItinerary`
 * flags any other id as `invented_venue`, and `admitOption` refuses one
 * at the exit regardless. Every stage failure is a typed result; only an
 * abort of `request.signal` throws.
 */
export async function runPipeline(request: PipelineRequest, deps: PipelineDeps): Promise<PipelineResult> {
  return withRequestTrace(
    { requestText: request.text, testCaseId: request.testCaseId, exporter: deps.exporter },
    (trace) => runStages(deps, request, trace),
  );
}
