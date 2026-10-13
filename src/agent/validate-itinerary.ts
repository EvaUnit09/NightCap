import type { ValidateItineraryInput } from "./types";
import type { AgentToolContext } from "./context";
import { toolError, toolOk, type ToolRunResult } from "./tool-result";

export async function runValidateItinerary(
  input: ValidateItineraryInput,
  ctx: AgentToolContext,
): Promise<ToolRunResult> {
  try {
    const errors = await ctx.validate({
      intent: ctx.intent,
      candidates: ctx.candidates,
      itinerary: input.itinerary,
    });
    return toolOk("validate_itinerary", {
      valid: errors.length === 0,
      errors,
      itinerary: input.itinerary,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError("validate_itinerary", "validate_failed", message);
  }
}
