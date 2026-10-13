import { allCandidates } from "../retrieval";
import type { SearchVenuesInput } from "../retrieval/query";
import type { AgentToolContext } from "./context";
import { toolError, toolOk, type ToolRunResult } from "./tool-result";

/**
 * Runs the shared retrieval path. Places transport failures become `is_error`.
 * An empty pool with `no_matches` is a normal result, not an error.
 */
export async function runSearchVenues(
  input: SearchVenuesInput,
  ctx: AgentToolContext,
): Promise<ToolRunResult> {
  const retrieval = await ctx.retrieve(input, ctx.signal);
  const outcome = retrieval.byStopType.get(input.category);
  if (outcome === undefined) {
    return toolError(
      "search_venues",
      "places_unavailable",
      `No retrieval outcome for category ${input.category}`,
      { placesRequests: retrieval.placesRequests },
    );
  }
  if (outcome.kind === "gap" && outcome.reason !== "no_matches") {
    return toolError(
      "search_venues",
      outcome.reason,
      `Places search failed: ${outcome.reason}`,
      { placesRequests: retrieval.placesRequests },
    );
  }
  const candidates = allCandidates(retrieval);
  return toolOk(
    "search_venues",
    {
      candidates,
      gapReason: outcome.kind === "gap" ? outcome.reason : null,
    },
    { placesRequests: retrieval.placesRequests },
  );
}
