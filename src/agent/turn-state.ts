import type { Candidate } from "../validation/candidate";
import type { Itinerary } from "../validation/itinerary";
import type { MutableAgentMetrics } from "./metrics";

export interface AgentTurnState {
  itinerary: Itinerary;
  lastValidItinerary: Itinerary;
  allowedPlaceIds: Set<string>;
  candidates: Candidate[];
  lastValidateOk: boolean;
  workingInvalid: boolean;
  replyText: string;
  metrics: MutableAgentMetrics;
}

export function createTurnState(itinerary: Itinerary, candidates: readonly Candidate[]): AgentTurnState {
  return {
    itinerary: structuredClone(itinerary),
    lastValidItinerary: structuredClone(itinerary),
    allowedPlaceIds: new Set(),
    candidates: [...candidates],
    lastValidateOk: false,
    workingInvalid: false,
    replyText: "",
    metrics: {
      toolCalls: 0,
      modelCalls: 0,
      placesRequests: 0,
      routesHops: 0,
      costUsd: 0,
      reverts: 0,
      validatedBeforeFinal: false,
      refused: false,
      stoppedReason: "completed",
    },
  };
}
