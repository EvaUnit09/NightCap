import "server-only";

import { withStage } from "../monitoring/tracing";
import type { Candidate } from "../validation/candidate";
import { normalizeModelTravelModes } from "../validation/common";
import type { Intent } from "../validation/intent";
import { itineraryOptionSchemaFor, type ItineraryOption } from "../validation/itinerary";
import type { ValidatorInput } from "../validation/validator";
import type { ValidationError } from "../validation/validation-error";
import { admitOption, unknownPlaceIds, type EmittedOption } from "./emit-gate";
import type { DroppedOption, InventedPlaceId, ModelCallRecord, WorkingOption } from "./lifecycle";
import type { ModelClient } from "./model-client";
import { errorsByOption, isRepairable, mergeRepair } from "./repair";
import { callModelStage } from "./stage-call";
import { repairMessage } from "./stage-messages";

export const REPAIR_MAX_TOKENS = 8_000;

export interface RepairLoopDeps {
  readonly models: ModelClient;
  readonly validate: (input: ValidatorInput) => Promise<ValidationError[]>;
  readonly repairMaxRounds: number;
  readonly repairPromptVersion: string;
}

export interface RepairLoopInput {
  readonly intent: Intent;
  readonly candidates: readonly Candidate[];
  readonly planned: readonly ItineraryOption[];
  readonly signal?: AbortSignal;
}

export interface RepairLoopResult {
  readonly emitted: readonly EmittedOption[];
  readonly dropped: readonly DroppedOption[];
  readonly modelCalls: readonly ModelCallRecord[];
  readonly inventedPlaceIds: readonly InventedPlaceId[];
  readonly roundsRun: number;
}

/** Where one option stands after a validation pass. */
type OptionState =
  | { readonly kind: "accepted"; readonly working: WorkingOption }
  | { readonly kind: "failing"; readonly working: WorkingOption; readonly errors: readonly ValidationError[] };

interface RepairOutcome {
  readonly working: WorkingOption;
  readonly call: ModelCallRecord;
  readonly invented: readonly InventedPlaceId[];
}

async function validatePass(
  deps: RepairLoopDeps,
  input: RepairLoopInput,
  options: readonly WorkingOption[],
): Promise<ValidationError[]> {
  return withStage({ stage: "validate" }, async (span) => {
    const errors = await deps.validate({
      intent: input.intent,
      candidates: input.candidates,
      itinerary: { singleStop: input.intent.singleStop, options: options.map((working) => working.option) },
    });
    span.record({ outcomeCodes: errors.map((error) => error.code) });
    return errors;
  });
}

async function repairOption(
  deps: RepairLoopDeps,
  input: RepairLoopInput,
  failing: Extract<OptionState, { kind: "failing" }>,
  round: number,
): Promise<RepairOutcome> {
  const { working, errors } = failing;
  const outcome = await callModelStage(deps.models, {
    stage: "repair_itinerary",
    promptVersion: deps.repairPromptVersion,
    user: repairMessage(input.intent.singleStop, working.option, errors, input.candidates),
    maxTokens: REPAIR_MAX_TOKENS,
    parse: (json) => itineraryOptionSchemaFor(input.intent.singleStop).safeParse(normalizeModelTravelModes(json)),
    outcomeCodes: errors.map((error) => error.code),
    signal: input.signal,
  });
  if (outcome.kind === "failed") {
    return { working: { ...working, repairRounds: round }, call: outcome.call, invented: [] };
  }
  const candidateIds = new Set(input.candidates.map((candidate) => candidate.placeId));
  const invented = unknownPlaceIds(outcome.value, candidateIds).map((placeId) => ({
    stage: "repair" as const,
    round,
    optionIndex: working.optionIndex,
    placeId,
  }));
  const option = mergeRepair(working.option, outcome.value, errors);
  return { working: { ...working, option, repairRounds: round }, call: outcome.call, invented };
}

function judge(working: WorkingOption, errors: readonly ValidationError[]): OptionState {
  return errors.length === 0 ? { kind: "accepted", working } : { kind: "failing", working, errors };
}

/** Re-judge the options that changed; the rest keep their state. */
function nextStates(
  states: readonly OptionState[],
  errors: readonly ValidationError[],
  changed: readonly number[],
): OptionState[] {
  const byOption = errorsByOption(errors, changed);
  return states.map((state) => {
    const found = byOption.get(state.working.optionIndex);
    return found === undefined ? state : judge(state.working, found);
  });
}

function withRepairs(states: readonly OptionState[], repairs: readonly RepairOutcome[]): OptionState[] {
  const byIndex = new Map(repairs.map((repair) => [repair.working.optionIndex, repair.working]));
  return states.map((state) => {
    const repaired = byIndex.get(state.working.optionIndex);
    return repaired === undefined ? state : { ...state, working: repaired };
  });
}

function repairable(states: readonly OptionState[]): Extract<OptionState, { kind: "failing" }>[] {
  return states.flatMap((state) => (state.kind === "failing" && isRepairable(state.errors) ? [state] : []));
}

function settle(states: readonly OptionState[], candidates: readonly Candidate[]) {
  const candidateIds = new Set(candidates.map((candidate) => candidate.placeId));
  const emitted: EmittedOption[] = [];
  const dropped: DroppedOption[] = [];
  for (const state of states) {
    const { optionIndex, repairRounds } = state.working;
    if (state.kind === "failing") {
      const reason = isRepairable(state.errors) ? "repair_exhausted" : "unrepairable";
      dropped.push({ optionIndex, reason, repairRounds, lastCodes: state.errors.map((error) => error.code) });
      continue;
    }
    const admit = admitOption(state.working, candidateIds);
    if (admit.kind === "admitted") {
      emitted.push(admit.option);
    } else {
      dropped.push({ optionIndex, reason: "invented_venue", repairRounds, lastCodes: ["invented_venue"] });
    }
  }
  return { emitted, dropped };
}

/**
 * Validate the planned options, repair only the failing ones for at most
 * `repairMaxRounds` rounds, then drop what still fails. Every pass
 * validates the whole plan, so the validator always sees 2–3 options and
 * memoizes shared legs; options are dropped only after the last round.
 */
export async function validateAndRepair(deps: RepairLoopDeps, input: RepairLoopInput): Promise<RepairLoopResult> {
  const planned: WorkingOption[] = input.planned.map((option, optionIndex) => ({
    optionIndex,
    option,
    repairRounds: 0,
  }));
  const firstPass = errorsByOption(
    await validatePass(deps, input, planned),
    planned.map((working) => working.optionIndex),
  );
  let states = planned.map((working) => judge(working, firstPass.get(working.optionIndex) ?? []));
  const modelCalls: ModelCallRecord[] = [];
  const inventedPlaceIds: InventedPlaceId[] = [];
  let round = 0;
  while (round < deps.repairMaxRounds && repairable(states).length > 0) {
    round += 1;
    const targets = repairable(states);
    const repairs = await Promise.all(targets.map((state) => repairOption(deps, input, state, round)));
    modelCalls.push(...repairs.map((repair) => repair.call));
    inventedPlaceIds.push(...repairs.flatMap((repair) => repair.invented));
    states = withRepairs(states, repairs);
    const errors = await validatePass(deps, input, states.map((state) => state.working));
    states = nextStates(states, errors, targets.map((state) => state.working.optionIndex));
  }
  return { ...settle(states, input.candidates), modelCalls, inventedPlaceIds, roundsRun: round };
}
