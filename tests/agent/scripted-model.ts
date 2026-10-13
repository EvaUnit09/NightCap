import type {
  AgentContentBlock,
  AgentModelPort,
  AgentModelRequest,
  AgentModelResponse,
} from "../../src/agent/model-port";

export type ScriptedTurn =
  | { readonly content: readonly AgentContentBlock[]; readonly stopReason?: AgentModelResponse["stopReason"] }
  | ((request: AgentModelRequest, callIndex: number) => AgentModelResponse);

export function scriptedModel(turns: readonly ScriptedTurn[]): AgentModelPort & {
  readonly requests: () => readonly AgentModelRequest[];
} {
  const seen: AgentModelRequest[] = [];
  let index = 0;
  return {
    requests: () => seen,
    async complete(request) {
      seen.push(request);
      const turn = turns[index];
      if (turn === undefined) {
        throw new Error(`scripted model exhausted at call ${index}`);
      }
      index += 1;
      if (typeof turn === "function") {
        return turn(request, index - 1);
      }
      return {
        stopReason: turn.stopReason ?? (turn.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"),
        content: turn.content,
        inputTokens: 100,
        outputTokens: 50,
      };
    },
  };
}

export function textTurn(text: string): ScriptedTurn {
  return { content: [{ type: "text", text }], stopReason: "end_turn" };
}

export function toolTurn(
  name: string,
  input: Record<string, unknown>,
  id = `tool_${name}`,
): ScriptedTurn {
  return {
    content: [{ type: "tool_use", id, name, input }],
    stopReason: "tool_use",
  };
}
