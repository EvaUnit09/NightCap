import type { ReplaceStopInput } from "./types";
import type { AgentToolContext } from "./context";
import { toolError, toolOk, type ToolRunResult } from "./tool-result";

export async function runReplaceStop(
  input: ReplaceStopInput,
  ctx: AgentToolContext,
): Promise<ToolRunResult> {
  const option = ctx.itinerary.options[input.optionIndex];
  if (option === undefined) {
    return toolError("replace_stop", "unknown_option", `Unknown optionIndex ${input.optionIndex}`);
  }
  const current = option.stops[input.stopIndex];
  if (current === undefined) {
    return toolError("replace_stop", "unknown_stop", `Unknown stopIndex ${input.stopIndex}`);
  }
  if (!ctx.allowedPlaceIds.has(input.placeId)) {
    return toolError(
      "replace_stop",
      "unknown_place_id",
      `Place id ${input.placeId} is not from a search_venues result in this turn`,
    );
  }
  const candidate = ctx.candidates.find((entry) => entry.placeId === input.placeId);
  if (candidate === undefined) {
    return toolError(
      "replace_stop",
      "unknown_place_id",
      `No candidate facts for place id ${input.placeId}`,
    );
  }

  const nextStop = { ...current, placeId: candidate.placeId, name: candidate.name };
  const nextStops = option.stops.map((stop, index) => (index === input.stopIndex ? nextStop : stop));
  const nextOptions = ctx.itinerary.options.map((entry, index) =>
    index === input.optionIndex ? { ...entry, stops: nextStops } : entry,
  );
  const itinerary = { ...ctx.itinerary, options: nextOptions };
  return toolOk("replace_stop", { itinerary, replaced: { optionIndex: input.optionIndex, stopIndex: input.stopIndex, placeId: input.placeId } });
}
