import { runRefineAgent, type RefineAgentResult } from "../../src/agent";
import type { Retrieval } from "../../src/retrieval";
import type { Candidate } from "../../src/validation/candidate";
import type { AgentEvalCase, AgentScript } from "./cases";
import {
  agentEvalCandidate,
  agentEvalIntent,
  agentEvalItinerary,
} from "./fixtures";
import { portForScript } from "./scripted-port";

export interface AgentCaseRecord {
  readonly id: string;
  readonly kind: AgentEvalCase["kind"];
  readonly completed: boolean;
  readonly postEditValid: boolean;
  readonly steps: number;
  readonly costUsd: number;
  readonly resultKind: RefineAgentResult["kind"];
  readonly refused: boolean;
  readonly reverts: number;
}

function seedCandidates(): Candidate[] {
  const itinerary = agentEvalItinerary();
  return itinerary.options.flatMap((option) =>
    option.stops.map((stop) => agentEvalCandidate(stop.placeId)),
  );
}

function retrievalFor(script: AgentScript, placeId: string | undefined): Retrieval {
  if (placeId === undefined) {
    return { byStopType: new Map(), placesRequests: 0 };
  }
  const candidate = agentEvalCandidate(placeId, "dinner");
  return {
    byStopType: new Map([["dinner", { kind: "ranked", candidates: [candidate] }]]),
    placesRequests: script.kind === "search_replace_validate" ? 1 : 0,
  };
}

function placeIdOf(script: AgentScript): string | undefined {
  switch (script.kind) {
    case "search_replace_validate":
    case "replace_then_validate":
      return script.placeId;
    default:
      return undefined;
  }
}

function isCompleted(evalCase: AgentEvalCase, result: RefineAgentResult): boolean {
  switch (evalCase.script.kind) {
    case "off_topic":
      return result.kind === "refused";
    case "end_without_validate":
    case "invent_venue":
    case "inject_prompt":
    case "contradict_budget":
    case "validate_fail":
      return result.kind === "reverted" || (result.kind === "updated" && result.itinerary.options[0].stops[0].placeId === "place-a");
    case "validate_only":
    case "reorder_then_validate":
    case "replace_then_validate":
    case "search_replace_validate":
      return result.kind === "updated" && result.metrics.validatedBeforeFinal;
    default: {
      const _exhaustive: never = evalCase.script;
      return _exhaustive;
    }
  }
}

export async function runAgentCase(evalCase: AgentEvalCase): Promise<AgentCaseRecord> {
  const itinerary = agentEvalItinerary();
  const intent = agentEvalIntent();
  const candidates = seedCandidates();
  const placeId = placeIdOf(evalCase.script);
  const validateFails =
    evalCase.script.kind === "contradict_budget" || evalCase.script.kind === "validate_fail";

  const result = await runRefineAgent(
    {
      editText: evalCase.editText,
      itinerary,
      intent,
      candidates,
    },
    {
      models: portForScript(evalCase.script, itinerary),
      retrieve: async () => retrievalFor(evalCase.script, placeId),
      validate: async () =>
        validateFails ? [{ code: "over_budget", message: "over budget" }] : [],
      modelId: "claude-haiku-5-5",
    },
  );

  const postEditValid =
    result.kind === "refused" ||
    result.kind === "reverted" ||
    (result.kind === "updated" && result.metrics.validatedBeforeFinal);

  return {
    id: evalCase.id,
    kind: evalCase.kind,
    completed: isCompleted(evalCase, result),
    postEditValid,
    steps: result.metrics.toolCalls,
    costUsd: result.metrics.costUsd,
    resultKind: result.kind,
    refused: result.metrics.refused,
    reverts: result.metrics.reverts,
  };
}

export async function runAgentCases(
  cases: readonly AgentEvalCase[],
): Promise<readonly AgentCaseRecord[]> {
  const records: AgentCaseRecord[] = [];
  for (const evalCase of cases) {
    records.push(await runAgentCase(evalCase));
  }
  return records;
}
