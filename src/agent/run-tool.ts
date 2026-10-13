import { parseToolInput } from "../validation";
import type { AgentToolContext } from "./context";
import { runReorderStops } from "./reorder-stops";
import { runReplaceStop } from "./replace-stop";
import { runSearchVenues } from "./search-venues";
import { toolError, type ToolRunResult } from "./tool-result";
import { runValidateItinerary } from "./validate-itinerary";

/** Parse unknown tool input with the shared Zod contract, then dispatch. */
export async function runAgentTool(input: unknown, ctx: AgentToolContext): Promise<ToolRunResult> {
  let parsed;
  try {
    parsed = parseToolInput(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError("search_venues", "invalid_tool_input", message);
  }

  switch (parsed.tool) {
    case "search_venues":
      return runSearchVenues(parsed, ctx);
    case "replace_stop":
      return runReplaceStop(parsed, ctx);
    case "reorder_stops":
      return runReorderStops(parsed, ctx);
    case "validate_itinerary":
      return runValidateItinerary(parsed, ctx);
    default: {
      const _exhaustive: never = parsed;
      return toolError("search_venues", "unknown_tool", `Unhandled tool ${JSON.stringify(_exhaustive)}`);
    }
  }
}
