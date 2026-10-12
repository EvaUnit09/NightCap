import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Anthropic from "@anthropic-ai/sdk";

import { ModelCallError, createAnthropicModelClient, type ModelErrorCode } from "../../src/pipeline";

/**
 * The real SDK over a fake `fetch`, so each error is built by the SDK's own
 * status-to-class mapping, exactly as a live failure would be.
 */

const SECRET_TEXT = "sk-ant-SECRET West Village upstream detail";

function errorBody(status: number): Response {
  return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: SECRET_TEXT } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sdkWith(fetch: (url: unknown, init: RequestInit) => Promise<Response>, timeout = 5_000): Anthropic {
  return new Anthropic({ apiKey: "test-key", fetch: fetch as typeof globalThis.fetch, maxRetries: 0, timeout });
}

const REQUEST = { stage: "plan_itineraries", model: "claude-sonnet-5", system: "sys", user: "u", maxTokens: 100 } as const;

async function thrownBy(client: Anthropic, signal?: AbortSignal): Promise<unknown> {
  try {
    await createAnthropicModelClient({ client }).complete({ ...REQUEST, signal });
  } catch (error) {
    return error;
  }
  assert.fail("complete() resolved");
}

async function codeFor(client: Anthropic): Promise<ModelErrorCode> {
  const error = await thrownBy(client);
  assert.ok(error instanceof ModelCallError, `expected ModelCallError, got ${String(error)}`);
  assert.equal(error.message, error.code, "the message is the code and nothing else");
  assert.doesNotMatch(JSON.stringify({ ...error, message: error.message, stack: error.stack }), /SECRET|West Village/);
  return error.code;
}

describe("Anthropic SDK failures as ModelErrorCode", () => {
  const byStatus: ReadonlyArray<readonly [number, ModelErrorCode]> = [
    [400, "bad_request"],
    [401, "auth"],
    [402, "billing"],
    [403, "auth"],
    [404, "not_found"],
    [409, "bad_request"],
    [413, "bad_request"],
    [422, "bad_request"],
    [429, "rate_limited"],
    [500, "server_error"],
    [503, "server_error"],
    [529, "overloaded"],
  ];
  for (const [status, expected] of byStatus) {
    it(`HTTP ${status} is ${expected}`, async () => {
      assert.equal(await codeFor(sdkWith(async () => errorBody(status))), expected);
    });
  }

  it("a request that outlives the client timeout is timeout", async () => {
    const hang = (_url: unknown, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    assert.equal(await codeFor(sdkWith(hang, 20)), "timeout");
  });

  it("a fetch that fails to connect is network", async () => {
    const refuse = async () => {
      throw new TypeError(`fetch failed: ${SECRET_TEXT}`);
    };
    assert.equal(await codeFor(sdkWith(refuse)), "network");
  });

  it("anything thrown without an API response or connection error is client_error", async () => {
    const broken = {
      messages: {
        create: async () => {
          throw new Error(SECRET_TEXT);
        },
      },
    } as unknown as Anthropic;
    assert.equal(await codeFor(broken), "client_error");
  });

  it("an abort of the caller's signal rethrows unclassified", async () => {
    const controller = new AbortController();
    const hang = (_url: unknown, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        controller.abort();
      });
    const error = await thrownBy(sdkWith(hang), controller.signal);
    assert.equal(error instanceof ModelCallError, false);
  });
});
