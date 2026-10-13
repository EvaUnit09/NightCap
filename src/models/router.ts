import "server-only";

import type { PipelineStage } from "../pipeline/prompt-loader";
import {
  getAgentModelId,
  getPlanModelId,
  getParseModelId,
  getRepairModelId,
} from "./config";

/**
 * Static model router: maps pipeline stages to model IDs.
 * No dynamic routing in v1 (architecture §2.9).
 *
 * Routing (decision #43). Every stage is Haiku 5.5. It is the cheapest
 * model that still answers these prompts, at $0.10 / $0.50 per million
 * tokens under 100k input tokens.
 *
 * Model IDs come from config, not hardcoded.
 */

/**
 * Get the model ID for a given pipeline stage.
 *
 * Exhaustive switch with never default ensures all stages are handled.
 *
 * @param stage - Pipeline stage name
 * @returns Model ID to use for that stage (e.g., "claude-haiku-5-5")
 */
export function getModelFor(stage: PipelineStage): string {
  switch (stage) {
    case "parse_intent":
      return getParseModelId();
    case "plan_itineraries":
      return getPlanModelId();
    case "repair_itinerary":
      return getRepairModelId();
    case "refine_agent":
      return getAgentModelId();
    default: {
      const exhaustive: never = stage;
      throw new Error(`Unknown pipeline stage at runtime: ${String(exhaustive)}`);
    }
  }
}
