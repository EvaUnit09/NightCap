/** One tool the model may call. */
export interface AgentToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

export type AgentContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: unknown };

export type AgentUserContent =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_result";
      readonly tool_use_id: string;
      readonly content: string;
      readonly is_error?: boolean;
    };

export type AgentMessage =
  | { readonly role: "user"; readonly content: string | readonly AgentUserContent[] }
  | { readonly role: "assistant"; readonly content: readonly AgentContentBlock[] };

export type AgentStopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface AgentModelRequest {
  readonly model: string;
  readonly system: string;
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly AgentToolDefinition[];
  readonly maxTokens: number;
  readonly signal?: AbortSignal;
}

export interface AgentModelResponse {
  readonly stopReason: AgentStopReason;
  readonly content: readonly AgentContentBlock[];
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Port for one refine-agent model call. Tests inject a scripted fake. */
export interface AgentModelPort {
  complete(request: AgentModelRequest): Promise<AgentModelResponse>;
}
