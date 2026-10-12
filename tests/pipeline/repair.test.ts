import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type Anthropic from "@anthropic-ai/sdk";

import { costUsdFor, resetConfig } from "../../src/models";
import { createAnthropicModelClient, extractJson } from "../../src/pipeline";
import { createAnthropicSdkClient } from "../../src/pipeline/anthropic-model-client";
import { errorsByOption, isRepairable, mergeRepair } from "../../src/pipeline/repair";
import type { ValidationError } from "../../src/validation/validation-error";
import { OPTION_A, stop } from "./orchestrator-harness";

const threeStops = {
  theme: "Three stops",
  stops: [
    stop("ChIJbar0", "Little Branch", "19:00", "20:00", 40, 10),
    stop("ChIJdin0", "Via Carota", "20:15", "21:30", 100, 10),
    stop("ChIJbar2", "Katana Kitten", "21:45", "22:45", 40, null),
  ],
};

const err = (code: ValidationError["code"], optionIndex?: number, stopIndex?: number): ValidationError => ({
  code,
  message: code,
  ...(optionIndex === undefined ? {} : { optionIndex }),
  ...(stopIndex === undefined ? {} : { stopIndex }),
});

describe("mergeRepair", () => {
  const edited = {
    theme: "Rewritten theme",
    stops: threeStops.stops.map((s) => ({ ...s, why: "rewritten", travelToNext: s.travelToNext && { mode: "TRANSIT" as const, minutes: 9 } })),
  };

  it("keeps passing stops, takes the failing stop, and only the leg into it from the stop before", () => {
    const merged = mergeRepair(threeStops, edited, [err("closed", 0, 1)]);
    assert.equal(merged.theme, "Three stops");
    assert.deepEqual(merged.stops[0], { ...threeStops.stops[0], travelToNext: { mode: "TRANSIT", minutes: 9 } });
    assert.deepEqual(merged.stops[1], edited.stops[1]);
    assert.deepEqual(merged.stops[2], threeStops.stops[2]);
  });

  it("takes the whole edit when a finding covers the option", () => {
    assert.deepEqual(mergeRepair(threeStops, edited, [err("over_budget", 0)]), edited);
  });

  it("takes the whole edit when the stop count changed", () => {
    assert.deepEqual(mergeRepair(threeStops, OPTION_A, [err("closed", 0, 1)]), OPTION_A);
  });
});

describe("errorsByOption and isRepairable", () => {
  it("charges unattributed findings to every changed option", () => {
    const byOption = errorsByOption([err("closed", 0, 1), err("invalid_format")], [0, 1]);
    assert.deepEqual(byOption.get(0)?.map((e) => e.code), ["closed", "invalid_format"]);
    assert.deepEqual(byOption.get(1)?.map((e) => e.code), ["invalid_format"]);
    assert.equal(byOption.has(2), false);
  });

  it("travel_service_unavailable alone is not repairable", () => {
    assert.equal(isRepairable([err("travel_service_unavailable", 0, 0)]), false);
    assert.equal(isRepairable([err("travel_service_unavailable", 0, 0), err("closed", 0, 1)]), true);
  });
});

describe("extractJson", () => {
  it("reads a fenced block, bare JSON, and nothing else", () => {
    assert.deepEqual(extractJson('Here:\n```json\n{"a":1}\n```\nthanks'), { a: 1 });
    assert.deepEqual(extractJson(' {"a":2} '), { a: 2 });
    assert.equal(extractJson("no json here"), undefined);
  });
});

describe("createAnthropicModelClient", () => {
  it("sends one Messages call and maps text, usage, and stop reason", async () => {
    const bodies: unknown[] = [];
    const fake = {
      messages: {
        create: async (body: unknown) => {
          bodies.push(body);
          return {
            content: [
              { type: "thinking", thinking: "" },
              { type: "text", text: '{"ok":' },
              { type: "text", text: "true}" },
            ],
            stop_reason: "end_turn",
            usage: { input_tokens: 12, output_tokens: 5 },
          };
        },
      },
    } as unknown as Anthropic;

    const response = await createAnthropicModelClient({ client: fake }).complete({
      stage: "plan_itineraries",
      model: "claude-sonnet-5",
      system: "sys",
      user: "u",
      maxTokens: 100,
    });

    assert.deepEqual(response, { text: '{"ok":true}', stopReason: "end_turn", inputTokens: 12, outputTokens: 5 });
    assert.deepEqual(bodies, [
      { model: "claude-sonnet-5", max_tokens: 100, system: "sys", messages: [{ role: "user", content: "u" }] },
    ]);
  });
});

describe("createAnthropicModelClient temperature", () => {
  function recordingClient(bodies: Array<Record<string, unknown>>): Anthropic {
    return {
      messages: {
        create: async (body: Record<string, unknown>) => {
          bodies.push(body);
          return { content: [], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
        },
      },
    } as unknown as Anthropic;
  }

  it("sends temperature 0 on parse (Haiku 4.5) and none on plan or repair (Sonnet 5)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const models = createAnthropicModelClient({ client: recordingClient(bodies) });
    const base = { system: "s", user: "u", maxTokens: 10 };

    await models.complete({ ...base, stage: "parse_intent", model: "claude-haiku-4-5" });
    await models.complete({ ...base, stage: "plan_itineraries", model: "claude-sonnet-5" });
    await models.complete({ ...base, stage: "repair_itinerary", model: "claude-sonnet-5" });

    assert.equal(bodies[0].temperature, 0);
    assert.equal("temperature" in bodies[1], false);
    assert.equal("temperature" in bodies[2], false);
  });
});

describe("createAnthropicSdkClient", () => {
  it("passes the configured timeout and retries to the SDK client", () => {
    const saved = { ...process.env };
    try {
      process.env.ANTHROPIC_API_KEY = "test-key";
      process.env.ANTHROPIC_TIMEOUT_MS = "12345";
      process.env.ANTHROPIC_MAX_RETRIES = "0";
      resetConfig();
      const sdk = createAnthropicSdkClient();
      assert.equal(sdk.timeout, 12345);
      assert.equal(sdk.maxRetries, 0);
    } finally {
      process.env = saved;
      resetConfig();
    }
  });
});

describe("costUsdFor", () => {
  it("prices listed models and leaves unknown ones unpriced", () => {
    assert.equal(costUsdFor("claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 12);
    assert.equal(costUsdFor("claude-unknown", { inputTokens: 1, outputTokens: 1 }), undefined);
    assert.equal(costUsdFor("constructor", { inputTokens: 1, outputTokens: 1 }), undefined);
  });
});
