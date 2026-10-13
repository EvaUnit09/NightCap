import type { Candidate } from "../validation/candidate";
import type { Itinerary } from "../validation/itinerary";
import type { MutableAgentMetrics } from "./metrics";

export interface AgentTurnState {
  itinerary: Itinerary;
  lastValidItinerary: Itinerary;
  /** Place ids present on the turn-start itinerary. */
  readonly startPlaceIds: ReadonlySet<string>;
  /** Place ids from `search_venues` in this turn only (replace_stop gate). */
  allowedPlaceIds: Set<string>;
  /** Facts for start stops plus this turn's search hits. */
  candidates: Candidate[];
  lastValidateOk: boolean;
  /** True after replace/reorder until a successful validate. */
  workingInvalid: boolean;
  /** True when the draft differs from the turn-start / last-valid plan. */
  dirty: boolean;
  replyText: string;
  metrics: MutableAgentMetrics;
}

function startIdsOf(itinerary: Itinerary): Set<string> {
  return new Set(itinerary.options.flatMap((option) => option.stops.map((stop) => stop.placeId)));
}

function candidatesForStart(
  startPlaceIds: ReadonlySet<string>,
  candidates: readonly Candidate[],
): Candidate[] {
  const byId = new Map(candidates.map((candidate) => [candidate.placeId, candidate]));
  return [...startPlaceIds].flatMap((placeId) => {
    const candidate = byId.get(placeId);
    return candidate === undefined ? [] : [candidate];
  });
}

export function createTurnState(itinerary: Itinerary, candidates: readonly Candidate[]): AgentTurnState {
  const startPlaceIds = startIdsOf(itinerary);
  return {
    itinerary: structuredClone(itinerary),
    lastValidItinerary: structuredClone(itinerary),
    startPlaceIds,
    allowedPlaceIds: new Set(),
    candidates: candidatesForStart(startPlaceIds, candidates),
    lastValidateOk: false,
    workingInvalid: false,
    dirty: false,
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

/** Place ids the model may put on the itinerary this turn. */
export function admissiblePlaceIds(state: AgentTurnState): Set<string> {
  return new Set([...state.startPlaceIds, ...state.allowedPlaceIds]);
}
