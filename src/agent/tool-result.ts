/** Discriminated result every agent tool returns to the turn loop. */
export type ToolRunResult =
  | {
      readonly is_error: false;
      readonly tool: "search_venues" | "replace_stop" | "reorder_stops" | "validate_itinerary";
      readonly content: unknown;
      readonly placesRequests?: number;
    }
  | {
      readonly is_error: true;
      readonly tool: "search_venues" | "replace_stop" | "reorder_stops" | "validate_itinerary";
      readonly error: { readonly code: string; readonly message: string };
      readonly placesRequests?: number;
    };

export function toolOk(
  tool: ToolRunResult["tool"],
  content: unknown,
  extras: { readonly placesRequests?: number } = {},
): ToolRunResult {
  return {
    is_error: false,
    tool,
    content,
    ...(extras.placesRequests === undefined ? {} : { placesRequests: extras.placesRequests }),
  };
}

export function toolError(
  tool: ToolRunResult["tool"],
  code: string,
  message: string,
  extras: { readonly placesRequests?: number } = {},
): ToolRunResult {
  return {
    is_error: true,
    tool,
    error: { code, message },
    ...(extras.placesRequests === undefined ? {} : { placesRequests: extras.placesRequests }),
  };
}
