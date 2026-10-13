import type { ToolInput } from "../validation";

export type SearchVenuesInput = Extract<ToolInput, { tool: "search_venues" }>;
export type ReplaceStopInput = Extract<ToolInput, { tool: "replace_stop" }>;
export type ReorderStopsInput = Extract<ToolInput, { tool: "reorder_stops" }>;
export type ValidateItineraryInput = Extract<ToolInput, { tool: "validate_itinerary" }>;
