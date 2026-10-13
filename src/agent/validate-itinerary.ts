import { stampSingleStopFromIntent } from "../validation/single-stop";
import type { Itinerary } from "../validation/itinerary";
import type { ValidateItineraryInput } from "./types";
import type { AgentToolContext } from "./context";
import { toolError, toolOk, type ToolRunResult } from "./tool-result";

function placeIdsOf(itinerary: Itinerary): string[] {
  return itinerary.options.flatMap((option) => option.stops.map((stop) => stop.placeId));
}

export async function runValidateItinerary(
  input: ValidateItineraryInput,
  ctx: AgentToolContext,
): Promise<ToolRunResult> {
  const stamped = stampSingleStopFromIntent(input.itinerary, ctx.intent.singleStop);
  const unknown = placeIdsOf(stamped).filter((placeId) => !ctx.admissiblePlaceIds.has(placeId));
  if (unknown.length > 0) {
    return toolError(
      "validate_itinerary",
      "unknown_place_id",
      `Place id(s) not from this turn's start itinerary or search_venues: ${unknown.join(", ")}`,
    );
  }

  try {
    const errors = await ctx.validate({
      intent: ctx.intent,
      candidates: ctx.candidates,
      itinerary: stamped,
    });
    return toolOk("validate_itinerary", {
      valid: errors.length === 0,
      errors,
      itinerary: stamped,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError("validate_itinerary", "validate_failed", message);
  }
}
