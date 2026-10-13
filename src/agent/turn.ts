import { withStage } from "../monitoring";
import {
  getAgentMaxCostUsdPerTurn,
  getAgentMaxToolCalls,
} from "../models/config";
import { getModelFor } from "../models/router";
import { loadPrompt } from "../pipeline/prompt-loader";
import { wrapUserText } from "../pipeline/wrap-user-text";
import type { Candidate } from "../validation/candidate";
import type { Intent } from "../validation/intent";
import type { Itinerary } from "../validation/itinerary";
import type { ValidationError } from "../validation/validation-error";
import type { ValidatorInput, ValidatorOptions } from "../validation/validator";
import type { Retrieval, SearchVenuesInput } from "../retrieval";
import { billableRoutesHops } from "../monitoring/spend-cap";
import type { AgentToolContext } from "./context";
import { modelCostUsd, turnCostUsd } from "./cost";
import { freezeMetrics, type AgentMetrics } from "./metrics";
import type {
  AgentMessage,
  AgentModelPort,
  AgentUserContent,
} from "./model-port";
import { isOffTopic } from "./off-topic";
import { runAgentTool } from "./run-tool";
import { AGENT_TOOL_DEFINITIONS } from "./tools-schema";
import { createTurnState, type AgentTurnState } from "./turn-state";

const AGENT_MAX_TOKENS = 2048;
const REFUSED_REPLY =
  "I can only help refine this night-out itinerary. Ask for a venue swap, reorder, timing change, or budget tweak.";

export interface RefineAgentRequest {
  readonly editText: string;
  readonly itinerary: Itinerary;
  readonly intent: Intent;
  readonly candidates: readonly Candidate[];
  readonly signal?: AbortSignal;
}

export interface RefineAgentDeps {
  readonly models: AgentModelPort;
  readonly retrieve: (input: SearchVenuesInput, signal?: AbortSignal) => Promise<Retrieval>;
  readonly validate: (
    input: ValidatorInput,
    options?: ValidatorOptions,
  ) => Promise<readonly ValidationError[]>;
  readonly maxToolCalls?: number;
  readonly maxCostUsd?: number;
  readonly modelId?: string;
}

export type RefineAgentResult =
  | {
      readonly kind: "updated";
      readonly itinerary: Itinerary;
      readonly reply: string;
      readonly metrics: AgentMetrics;
    }
  | {
      readonly kind: "reverted";
      readonly itinerary: Itinerary;
      readonly reply: string;
      readonly metrics: AgentMetrics;
    }
  | {
      readonly kind: "refused";
      readonly itinerary: Itinerary;
      readonly reply: string;
      readonly metrics: AgentMetrics;
    };

function toolContext(state: AgentTurnState, deps: RefineAgentDeps, request: RefineAgentRequest): AgentToolContext {
  return {
    itinerary: state.itinerary,
    intent: request.intent,
    allowedPlaceIds: state.allowedPlaceIds,
    candidates: state.candidates,
    retrieve: deps.retrieve,
    validate: deps.validate,
    signal: request.signal,
  };
}

function applyToolResult(state: AgentTurnState, toolName: string, result: Awaited<ReturnType<typeof runAgentTool>>): void {
  if (result.placesRequests !== undefined) {
    state.metrics.placesRequests += result.placesRequests;
  }
  if (result.is_error) {
    return;
  }
  const content = result.content as Record<string, unknown>;
  switch (toolName) {
    case "search_venues": {
      const found = content.candidates;
      if (Array.isArray(found)) {
        for (const entry of found) {
          if (entry && typeof entry === "object" && "placeId" in entry && typeof entry.placeId === "string") {
            state.allowedPlaceIds.add(entry.placeId);
            const existing = state.candidates.some((candidate) => candidate.placeId === entry.placeId);
            if (!existing) {
              state.candidates.push(entry as Candidate);
            }
          }
        }
      }
      return;
    }
    case "replace_stop":
    case "reorder_stops": {
      if (content.itinerary && typeof content.itinerary === "object") {
        state.itinerary = content.itinerary as Itinerary;
        state.workingInvalid = true;
        state.metrics.validatedBeforeFinal = false;
        state.lastValidateOk = false;
      }
      return;
    }
    case "validate_itinerary": {
      const valid = content.valid === true;
      state.lastValidateOk = valid;
      if (valid) {
        const itinerary = (content.itinerary as Itinerary | undefined) ?? state.itinerary;
        state.itinerary = itinerary;
        state.lastValidItinerary = structuredClone(itinerary);
        state.workingInvalid = false;
        state.metrics.validatedBeforeFinal = true;
      } else {
        state.workingInvalid = true;
        state.metrics.validatedBeforeFinal = false;
      }
      state.metrics.routesHops += billableRoutesHops({
        itinerary: state.itinerary,
        candidates: state.candidates,
      });
      return;
    }
    default:
      return;
  }
}

function recomputeCost(state: AgentTurnState, modelUsd: number): void {
  state.metrics.costUsd = turnCostUsd({
    modelUsd,
    placesRequests: state.metrics.placesRequests,
    routesHops: state.metrics.routesHops,
  });
}

function finalize(
  state: AgentTurnState,
  kindHint: "updated" | "reverted" | "refused",
): RefineAgentResult {
  const needsRevert =
    kindHint !== "refused" &&
    (!state.metrics.validatedBeforeFinal || state.workingInvalid || !state.lastValidateOk);
  if (needsRevert) {
    state.metrics.reverts += 1;
    state.itinerary = structuredClone(state.lastValidItinerary);
    const explain =
      state.replyText.trim().length > 0
        ? `${state.replyText.trim()}\n\nI could not confirm a valid plan, so I kept your last valid itinerary.`
        : "I could not confirm a valid plan, so I kept your last valid itinerary.";
    return {
      kind: "reverted",
      itinerary: state.itinerary,
      reply: explain,
      metrics: freezeMetrics(state.metrics),
    };
  }
  if (kindHint === "refused") {
    return {
      kind: "refused",
      itinerary: state.itinerary,
      reply: state.replyText,
      metrics: freezeMetrics(state.metrics),
    };
  }
  return {
    kind: "updated",
    itinerary: state.itinerary,
    reply: state.replyText,
    metrics: freezeMetrics(state.metrics),
  };
}

async function runTurnBody(
  request: RefineAgentRequest,
  deps: RefineAgentDeps,
): Promise<RefineAgentResult> {
  const state = createTurnState(request.itinerary, request.candidates);
  const maxToolCalls = deps.maxToolCalls ?? getAgentMaxToolCalls();
  const maxCostUsd = deps.maxCostUsd ?? getAgentMaxCostUsdPerTurn();
  const modelId = deps.modelId ?? getModelFor("refine_agent");

  if (isOffTopic(request.editText)) {
    state.metrics.refused = true;
    state.metrics.stoppedReason = "refused";
    state.replyText = REFUSED_REPLY;
    return finalize(state, "refused");
  }

  const prompt = loadPrompt("refine_agent", "v1");
  const userPayload = [
    wrapUserText(request.editText),
    "",
    "Current itinerary (JSON data):",
    wrapUserText(JSON.stringify(request.itinerary)),
  ].join("\n");

  const messages: AgentMessage[] = [{ role: "user", content: userPayload }];
  let modelUsd = 0;

  while (true) {
    if (state.metrics.toolCalls >= maxToolCalls) {
      state.metrics.stoppedReason = "max_tool_calls";
      return finalize(state, "updated");
    }
    if (state.metrics.costUsd >= maxCostUsd) {
      state.metrics.stoppedReason = "max_cost";
      return finalize(state, "updated");
    }

    let response;
    try {
      response = await deps.models.complete({
        model: modelId,
        system: prompt.body,
        messages,
        tools: AGENT_TOOL_DEFINITIONS,
        maxTokens: AGENT_MAX_TOKENS,
        signal: request.signal,
      });
    } catch {
      state.metrics.stoppedReason = "model_error";
      state.replyText = "The refinement model failed. Your last valid itinerary is unchanged.";
      return finalize(state, "reverted");
    }

    state.metrics.modelCalls += 1;
    modelUsd += modelCostUsd(modelId, {
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    });
    recomputeCost(state, modelUsd);

    messages.push({ role: "assistant", content: response.content });

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text.length > 0) {
      state.replyText = text;
    }

    const toolUses = response.content.filter((block) => block.type === "tool_use");
    if (toolUses.length === 0) {
      state.metrics.stoppedReason = "completed";
      return finalize(state, "updated");
    }

    const toolResults: AgentUserContent[] = [];
    for (const toolUse of toolUses) {
      if (state.metrics.toolCalls >= maxToolCalls || state.metrics.costUsd >= maxCostUsd) {
        state.metrics.stoppedReason =
          state.metrics.toolCalls >= maxToolCalls ? "max_tool_calls" : "max_cost";
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify({
            is_error: true,
            error: { code: state.metrics.stoppedReason, message: "Turn budget exhausted" },
          }),
          is_error: true,
        });
        continue;
      }

      const input =
        toolUse.input && typeof toolUse.input === "object"
          ? { tool: toolUse.name, ...(toolUse.input as Record<string, unknown>) }
          : { tool: toolUse.name };
      const result = await runAgentTool(input, toolContext(state, deps, request));
      state.metrics.toolCalls += 1;
      applyToolResult(state, toolUse.name, result);
      recomputeCost(state, modelUsd);
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: JSON.stringify(result),
        ...(result.is_error ? { is_error: true } : {}),
      });
    }

    messages.push({ role: "user", content: toolResults });

    if (state.metrics.stoppedReason === "max_tool_calls" || state.metrics.stoppedReason === "max_cost") {
      return finalize(state, "updated");
    }
  }
}

/** Run one refinement turn on Haiku with tool and cost hard stops. */
export async function runRefineAgent(
  request: RefineAgentRequest,
  deps: RefineAgentDeps,
): Promise<RefineAgentResult> {
  return withStage({ stage: "agent" }, () => runTurnBody(request, deps));
}
