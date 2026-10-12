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
 * Why a call got no reply, derived from the SDK error class and HTTP status,
 * never from message text. `client_error` means it failed in this process
 * without an API response or a connection error: a missing key, an SDK-side
 * check, or a client that throws something other than `ModelCallError`.
 */
export type ModelErrorCode =
  | "timeout"
  | "network"
  | "bad_request"
  | "auth"
  | "billing"
  | "not_found"
  | "rate_limited"
  | "overloaded"
  | "server_error"
  | "client_error";

/** What a `ModelClient` throws when a call gets no reply. Its message is the code, nothing else. */
export class ModelCallError extends Error {
  constructor(readonly code: ModelErrorCode) {
    super(code);
    this.name = "ModelCallError";
  }
}

export function modelErrorCodeOf(error: unknown): ModelErrorCode {
  return error instanceof ModelCallError ? error.code : "client_error";
}

/**
 * The port every pipeline model call goes through. Tests pass a fake; the
 * server passes `createAnthropicModelClient()`. A call with no reply throws
 * a `ModelCallError`; anything else thrown counts as `client_error`.
 */
export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
}
