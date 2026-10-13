import "server-only";

import Anthropic, { APIConnectionError, APIConnectionTimeoutError, APIError } from "@anthropic-ai/sdk";

import { getAnthropicApiKey, getAnthropicClientSettings } from "../models/config";
import { getTemperatureParamFor } from "../models/temperature";
import {
  ModelCallError,
  type ModelClient,
  type ModelErrorCode,
  type ModelResponse,
  type ModelStopReason,
} from "./model-client";

/** HTTP statuses with their own code. Any other status is `server_error` from 500 up, else `bad_request`. */
const CODE_FOR_STATUS: Readonly<Record<number, ModelErrorCode>> = {
  401: "auth",
  402: "billing",
  403: "auth",
  404: "not_found",
  429: "rate_limited",
  529: "overloaded",
};

/** The SDK's error class and HTTP status as a `ModelErrorCode`. Message text is never read. */
export function classifyAnthropicError(error: unknown): ModelErrorCode {
  if (error instanceof APIConnectionTimeoutError) {
    return "timeout";
  }
  if (error instanceof APIConnectionError) {
    return "network";
  }
  if (!(error instanceof APIError) || error.status === undefined) {
    return "client_error";
  }
  return CODE_FOR_STATUS[error.status] ?? (error.status >= 500 ? "server_error" : "bad_request");
}

function stopReasonOf(reason: Anthropic.Message["stop_reason"]): ModelStopReason {
  switch (reason) {
    case "end_turn":
    case "max_tokens":
    case "refusal":
      return reason;
    default:
      return "other";
  }
}

function toResponse(message: Anthropic.Message): ModelResponse {
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  return {
    text,
    stopReason: stopReasonOf(message.stop_reason),
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}

/** SDK client with the configured timeout and retries, not the SDK defaults (10 min, 2 retries). */
export function createAnthropicSdkClient(): Anthropic {
  const { timeoutMs, maxRetries } = getAnthropicClientSettings();
  return new Anthropic({ apiKey: getAnthropicApiKey(), timeout: timeoutMs, maxRetries });
}

/**
 * The real `ModelClient`: one Messages API call per request. The key is
 * read lazily, so building the client never throws; a missing key throws
 * `client_error` on the first call and that stage fails as `model_error`.
 * Every other failure throws its `classifyAnthropicError` code, except an
 * abort of `request.signal`, which rethrows as is.
 * Temperature comes from `getTemperatureParamFor` and is sent only to
 * models that accept it. Haiku 5.5 and Sonnet 5 reject temperature,
 * top_p, and top_k with a 400. Haiku 4.5 accepts temperature.
 */
export function createAnthropicModelClient(
  options: { readonly client?: Anthropic } = {},
): ModelClient {
  let client = options.client;
  return {
    async complete(request) {
      const temperature = getTemperatureParamFor(request.stage, request.model);
      let message: Anthropic.Message;
      try {
        client ??= createAnthropicSdkClient();
        message = await client.messages.create(
          {
            model: request.model,
            max_tokens: request.maxTokens,
            ...(temperature === undefined ? {} : { temperature }),
            system: request.system,
            messages: [{ role: "user", content: request.user }],
          },
          { signal: request.signal },
        );
      } catch (error) {
        if (request.signal?.aborted) {
          throw error;
        }
        throw new ModelCallError(classifyAnthropicError(error));
      }
      return toResponse(message);
    },
  };
}
