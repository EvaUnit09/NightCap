import "server-only";

import type { PipelineStage } from "../pipeline/prompt-loader";

/**
 * Temperature settings per pipeline stage.
 * Single source of truth for model temperature configuration.
 *
 * Temperatures:
 * - parse_intent: 0 (deterministic extraction)
 * - plan_itineraries: 1 (creative planning with variety)
 * - repair_itinerary: 0.3 (focused fixes with some flexibility)
 * - refine_agent: 0.5 (balanced agent behavior)
 */
const TEMPERATURE_MAP: Record<PipelineStage, number> = {
  parse_intent: 0,
  plan_itineraries: 1,
  repair_itinerary: 0.3,
  refine_agent: 0.5,
};

/**
 * Get the temperature for a given pipeline stage.
 *
 * @param stage - Pipeline stage name
 * @returns Temperature (0-1) to use for that stage
 */
export function getTemperatureFor(stage: PipelineStage): number {
  switch (stage) {
    case "parse_intent":
    case "plan_itineraries":
    case "repair_itinerary":
    case "refine_agent":
      return TEMPERATURE_MAP[stage];
    default: {
      const exhaustive: never = stage;
      throw new Error(`Unknown pipeline stage at runtime: ${String(exhaustive)}`);
    }
  }
}

/**
 * Model id prefixes known to accept `temperature`. Sonnet 5 rejects
 * temperature/top_p/top_k with a 400, so the allowlist is closed: a model
 * not listed gets no temperature, which every model accepts.
 */
const TEMPERATURE_ACCEPTING_MODEL_PREFIXES: readonly string[] = ["claude-haiku-4-5"];

/** Whether the Messages API accepts a `temperature` for this model id. */
export function acceptsTemperature(modelId: string): boolean {
  return TEMPERATURE_ACCEPTING_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}

/**
 * Temperature to send for this stage on this model, or undefined when the
 * model rejects it. Values still come from `getTemperatureFor`.
 */
export function getTemperatureParamFor(stage: PipelineStage, modelId: string): number | undefined {
  return acceptsTemperature(modelId) ? getTemperatureFor(stage) : undefined;
}
