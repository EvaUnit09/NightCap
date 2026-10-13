import type {
  AgentModelPort,
  AgentModelRequest,
  AgentModelResponse,
} from "../../src/agent/model-port";
import type { Itinerary } from "../../src/validation/itinerary";
import type { AgentScript } from "./cases";
import { REORDER_TIMES } from "./fixtures";

function response(content: AgentModelResponse["content"], stopReason: AgentModelResponse["stopReason"]): AgentModelResponse {
  return { content, stopReason, inputTokens: 80, outputTokens: 40 };
}

function itineraryFromLastToolResult(request: AgentModelRequest, fallback: Itinerary): Itinerary {
  const last = request.messages.at(-1);
  if (!last || last.role !== "user" || !Array.isArray(last.content)) return fallback;
  const block = last.content[0];
  if (!block || block.type !== "tool_result") return fallback;
  try {
    const parsed = JSON.parse(block.content) as { content?: { itinerary?: Itinerary } };
    return parsed.content?.itinerary ?? fallback;
  } catch {
    return fallback;
  }
}

/** Builds a scripted model port for one agent eval case. */
export function portForScript(script: AgentScript, seedItinerary: Itinerary): AgentModelPort {
  let step = 0;
  return {
    async complete(request) {
      switch (script.kind) {
        case "off_topic":
          return response([{ type: "text", text: "should not run" }], "end_turn");
        case "validate_only":
          if (step++ === 0) {
            return response(
              [
                {
                  type: "tool_use",
                  id: "val",
                  name: "validate_itinerary",
                  input: { itinerary: seedItinerary },
                },
              ],
              "tool_use",
            );
          }
          return response([{ type: "text", text: "Validated." }], "end_turn");
        case "reorder_then_validate":
        case "end_without_validate":
        case "contradict_budget":
        case "validate_fail": {
          if (step === 0) {
            step += 1;
            return response(
              [
                {
                  type: "tool_use",
                  id: "reorder",
                  name: "reorder_stops",
                  input: { optionIndex: 0, order: [1, 0], times: [...REORDER_TIMES] },
                },
              ],
              "tool_use",
            );
          }
          if (script.kind === "end_without_validate") {
            return response([{ type: "text", text: "Reordered." }], "end_turn");
          }
          if (step === 1) {
            step += 1;
            const itinerary = itineraryFromLastToolResult(request, seedItinerary);
            return response(
              [
                {
                  type: "tool_use",
                  id: "val",
                  name: "validate_itinerary",
                  input: { itinerary },
                },
              ],
              "tool_use",
            );
          }
          return response([{ type: "text", text: "Done." }], "end_turn");
        }
        case "inject_prompt":
        case "replace_then_validate":
        case "invent_venue": {
          const placeId =
            script.kind === "inject_prompt" ? "invented-x" : script.placeId;
          if (step === 0) {
            step += 1;
            return response(
              [
                {
                  type: "tool_use",
                  id: "replace",
                  name: "replace_stop",
                  input: { optionIndex: 0, stopIndex: 0, placeId },
                },
              ],
              "tool_use",
            );
          }
          if (step === 1) {
            step += 1;
            const itinerary = itineraryFromLastToolResult(request, seedItinerary);
            return response(
              [
                {
                  type: "tool_use",
                  id: "val",
                  name: "validate_itinerary",
                  input: { itinerary },
                },
              ],
              "tool_use",
            );
          }
          return response([{ type: "text", text: "Done." }], "end_turn");
        }
        case "search_replace_validate": {
          if (step === 0) {
            step += 1;
            return response(
              [
                {
                  type: "tool_use",
                  id: "search",
                  name: "search_venues",
                  input: {
                    area: "West Village",
                    category: "dinner",
                    priceLevel: "PRICE_LEVEL_INEXPENSIVE",
                    openAt: "2026-10-10T19:00:00-04:00",
                  },
                },
              ],
              "tool_use",
            );
          }
          if (step === 1) {
            step += 1;
            return response(
              [
                {
                  type: "tool_use",
                  id: "replace",
                  name: "replace_stop",
                  input: { optionIndex: 0, stopIndex: 0, placeId: script.placeId },
                },
              ],
              "tool_use",
            );
          }
          if (step === 2) {
            step += 1;
            const itinerary = itineraryFromLastToolResult(request, seedItinerary);
            return response(
              [
                {
                  type: "tool_use",
                  id: "val",
                  name: "validate_itinerary",
                  input: { itinerary },
                },
              ],
              "tool_use",
            );
          }
          return response([{ type: "text", text: "Updated." }], "end_turn");
        }
        default: {
          const _exhaustive: never = script;
          throw new Error(`Unhandled script ${JSON.stringify(_exhaustive)}`);
        }
      }
    },
  };
}
