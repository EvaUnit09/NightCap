import type { AgentToolDefinition } from "./model-port";

/** Anthropic tool definitions aligned with `toolInputSchema`. */
export const AGENT_TOOL_DEFINITIONS: readonly AgentToolDefinition[] = [
  {
    name: "search_venues",
    description: "Find replacement venue candidates for one stop type in an area.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["tool", "area", "category", "priceLevel", "openAt"],
      properties: {
        tool: { type: "string", const: "search_venues" },
        area: { type: "string" },
        category: { type: "string" },
        priceLevel: { type: "string" },
        openAt: { type: "string" },
      },
    },
  },
  {
    name: "replace_stop",
    description: "Replace one stop with a place id from search_venues in this turn.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["tool", "optionIndex", "stopIndex", "placeId"],
      properties: {
        tool: { type: "string", const: "replace_stop" },
        optionIndex: { type: "integer" },
        stopIndex: { type: "integer" },
        placeId: { type: "string" },
      },
    },
  },
  {
    name: "reorder_stops",
    description: "Reorder or retime stops within one option.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["tool", "optionIndex", "order", "times"],
      properties: {
        tool: { type: "string", const: "reorder_stops" },
        optionIndex: { type: "integer" },
        order: { type: "array", items: { type: "integer" } },
        times: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["start", "end"],
            properties: {
              start: { type: "string" },
              end: { type: "string" },
            },
          },
        },
      },
    },
  },
  {
    name: "validate_itinerary",
    description: "Run the deterministic itinerary validator. Required before the final answer.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["tool", "itinerary"],
      properties: {
        tool: { type: "string", const: "validate_itinerary" },
        itinerary: { type: "object" },
      },
    },
  },
];
