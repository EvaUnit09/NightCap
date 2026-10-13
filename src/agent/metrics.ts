/** Counters for one refine-agent turn. */
export interface AgentMetrics {
  readonly toolCalls: number;
  readonly modelCalls: number;
  readonly placesRequests: number;
  readonly routesHops: number;
  readonly costUsd: number;
  readonly reverts: number;
  readonly validatedBeforeFinal: boolean;
  readonly refused: boolean;
  readonly stoppedReason: "completed" | "max_tool_calls" | "max_cost" | "refused" | "model_error";
}

export interface MutableAgentMetrics {
  toolCalls: number;
  modelCalls: number;
  placesRequests: number;
  routesHops: number;
  costUsd: number;
  reverts: number;
  validatedBeforeFinal: boolean;
  refused: boolean;
  stoppedReason: AgentMetrics["stoppedReason"];
}

export function createMetrics(): MutableAgentMetrics {
  return {
    toolCalls: 0,
    modelCalls: 0,
    placesRequests: 0,
    routesHops: 0,
    costUsd: 0,
    reverts: 0,
    validatedBeforeFinal: false,
    refused: false,
    stoppedReason: "completed",
  };
}

export function freezeMetrics(metrics: MutableAgentMetrics): AgentMetrics {
  return { ...metrics };
}
