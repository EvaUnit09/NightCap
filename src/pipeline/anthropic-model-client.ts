import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { getAnthropicApiKey, getAnthropicClientSettings } from "../models/config";
import { getTemperatureParamFor } from "../models/temperature";
import type { ModelClient, ModelResponse, ModelStopReason } from "./model-client";

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
 * on the first call and that stage fails as `model_error`.
 * Temperature comes from `getTemperatureParamFor` and is sent only to
 * models that accept it: the Claude API docs say Sonnet 5 rejects
 * temperature, top_p and top_k with a 400, while Haiku 4.5 accepts them.
 */
export function createAnthropicModelClient(
  options: { readonly client?: Anthropic } = {},
): ModelClient {
  let client = options.client;
  return {
    async complete(request) {
      client ??= createAnthropicSdkClient();
      const temperature = getTemperatureParamFor(request.stage, request.model);
      const message = await client.messages.create(
        {
          model: request.model,
          max_tokens: request.maxTokens,
          ...(temperature === undefined ? {} : { temperature }),
          system: request.system,
          messages: [{ role: "user", content: request.user }],
        },
        { signal: request.signal },
      );
      return toResponse(message);
    },
  };
}
