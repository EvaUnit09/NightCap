import type { ReorderStopsInput } from "./types";
import type { AgentToolContext } from "./context";
import { toolError, toolOk, type ToolRunResult } from "./tool-result";

export async function runReorderStops(
  input: ReorderStopsInput,
  ctx: AgentToolContext,
): Promise<ToolRunResult> {
  const option = ctx.itinerary.options[input.optionIndex];
  if (option === undefined) {
    return toolError("reorder_stops", "unknown_option", `Unknown optionIndex ${input.optionIndex}`);
  }
  const stopCount = option.stops.length;
  if (input.order.length !== stopCount || input.times.length !== stopCount) {
    return toolError(
      "reorder_stops",
      "invalid_order",
      `Order and times must cover exactly ${stopCount} stops`,
    );
  }
  const expected = new Set(Array.from({ length: stopCount }, (_, index) => index));
  for (const index of input.order) {
    if (!expected.has(index)) {
      return toolError("reorder_stops", "unknown_stop", `Unknown stop index ${index} in order`);
    }
    expected.delete(index);
  }
  if (expected.size !== 0) {
    return toolError("reorder_stops", "invalid_order", "Order must be a permutation of existing stop indices");
  }

  const nextStops = input.order.map((stopIndex, position) => {
    const prior = option.stops[stopIndex];
    const slot = input.times[position];
    const isLast = position === stopCount - 1;
    const travelFallback = option.stops[position]?.travelToNext ?? null;
    return {
      ...prior,
      start: slot.start,
      end: slot.end,
      travelToNext: isLast ? null : (prior.travelToNext ?? travelFallback),
    };
  });

  const nextOptions = ctx.itinerary.options.map((entry, index) =>
    index === input.optionIndex ? { ...entry, stops: nextStops } : entry,
  );
  const itinerary = { ...ctx.itinerary, options: nextOptions };
  return toolOk("reorder_stops", {
    itinerary,
    reordered: { optionIndex: input.optionIndex, order: input.order },
  });
}
