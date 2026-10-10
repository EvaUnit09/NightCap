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
