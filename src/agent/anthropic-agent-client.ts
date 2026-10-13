import "server-only";

import type Anthropic from "@anthropic-ai/sdk";

import { createAnthropicSdkClient } from "../pipeline/anthropic-model-client";
import type {
  AgentContentBlock,
  AgentModelPort,
  AgentModelRequest,
  AgentModelResponse,
  AgentStopReason,
  AgentUserContent,
} from "./model-port";

function stopReasonOf(reason: string | null): AgentStopReason {
  switch (reason) {
    case "end_turn":
    case "tool_use":
    case "max_tokens":
    case "refusal":
      return reason;
    default:
      return "other";
  }
}

function toApiMessages(messages: AgentModelRequest["messages"]): Anthropic.MessageParam[] {
  return messages.map((message) => {
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: message.content.map((block) => {
          if (block.type === "text") {
            return { type: "text" as const, text: block.text };
          }
          return {
            type: "tool_use" as const,
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          };
        }),
      };
    }
    if (typeof message.content === "string") {
      return { role: "user" as const, content: message.content };
    }
    return {
      role: "user" as const,
      content: message.content.map((block: AgentUserContent) => {
        if (block.type === "text") {
          return { type: "text" as const, text: block.text };
        }
        return {
          type: "tool_result" as const,
          tool_use_id: block.tool_use_id,
          content: block.content,
          ...(block.is_error ? { is_error: true } : {}),
        };
      }),
    };
  });
}

function toContent(blocks: Anthropic.ContentBlock[]): AgentContentBlock[] {
  return blocks.flatMap((block): AgentContentBlock[] => {
    if (block.type === "text") {
      return [{ type: "text", text: block.text }];
    }
    if (block.type === "tool_use") {
      return [{ type: "tool_use", id: block.id, name: block.name, input: block.input }];
    }
    return [];
  });
}

export function createAnthropicAgentModelPort(
  options: { readonly client?: Anthropic } = {},
): AgentModelPort {
  let client = options.client;
  return {
    async complete(request: AgentModelRequest): Promise<AgentModelResponse> {
      client ??= createAnthropicSdkClient();
      const message = await client.messages.create(
        {
          model: request.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: toApiMessages(request.messages),
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
          })),
        },
        { signal: request.signal },
      );
      return {
        stopReason: stopReasonOf(message.stop_reason),
        content: toContent(message.content),
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      };
    },
  };
}
