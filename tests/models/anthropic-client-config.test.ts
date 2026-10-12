import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { getAnthropicClientSettings, resetConfig } from "../../src/models";

const ENV = ["ANTHROPIC_TIMEOUT_MS", "ANTHROPIC_MAX_RETRIES"] as const;

describe("getAnthropicClientSettings", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const name of ENV) delete process.env[name];
    resetConfig();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
  });

  it("defaults to a 45s timeout and one retry", () => {
    assert.deepEqual(getAnthropicClientSettings(), { timeoutMs: 45_000, maxRetries: 1 });
  });

  it("reads both knobs from env, allowing zero retries", () => {
    process.env.ANTHROPIC_TIMEOUT_MS = "20000";
    process.env.ANTHROPIC_MAX_RETRIES = "0";
    assert.deepEqual(getAnthropicClientSettings(), { timeoutMs: 20_000, maxRetries: 0 });
  });

  it("treats a blank env var as unset", () => {
    process.env.ANTHROPIC_TIMEOUT_MS = "  ";
    assert.equal(getAnthropicClientSettings().timeoutMs, 45_000);
  });

  const outOfBounds: ReadonlyArray<readonly [string, string]> = [
    ["ANTHROPIC_TIMEOUT_MS", "999"],
    ["ANTHROPIC_TIMEOUT_MS", "300001"],
    ["ANTHROPIC_TIMEOUT_MS", "abc"],
    ["ANTHROPIC_MAX_RETRIES", "-1"],
    ["ANTHROPIC_MAX_RETRIES", "6"],
    ["ANTHROPIC_MAX_RETRIES", "1.5"],
  ];
  for (const [name, value] of outOfBounds) {
    it(`rejects ${name}=${value}`, () => {
      process.env[name] = value;
      assert.throws(() => getAnthropicClientSettings());
    });
  }
});
