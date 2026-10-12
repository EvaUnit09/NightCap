import type { PipelineStage } from "./prompt-loader";

/** Stages the request pipeline calls a model for. The agent has its own loop. */
export type ModelStage = Exclude<PipelineStage, "refine_agent">;

export interface ModelRequest {
  readonly stage: ModelStage;
  readonly model: string;
  /** Rendered prompt body from `loadPrompt`. */
  readonly system: string;
  /** Data for this call. User-authored text is already wrapped with `wrapUserText`. */
  readonly user: string;
  readonly maxTokens: number;
  readonly signal?: AbortSignal;
}

/** Why the model stopped. Anything but `end_turn` means the text may be incomplete. */
export type ModelStopReason = "end_turn" | "max_tokens" | "refusal" | "other";

export interface ModelResponse {
  readonly text: string;
  readonly stopReason: ModelStopReason;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * The port every pipeline model call goes through. Tests pass a fake; the
 * server passes `createAnthropicModelClient()`. Transport failures throw.
 */
export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
}
