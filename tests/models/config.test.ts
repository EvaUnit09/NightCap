import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  getAgentMaxCostUsdPerTurn,
  getAgentMaxToolCalls,
  getAgentModelId,
  getAnthropicApiKey,
  getConfig,
  getDatadogApiKey,
  getGooglePlacesApiKey,
  getParsedModelId,
  getPlacesCacheTtlHours,
  getPlanModelId,
  getRateLimitDailySpendUsd,
  getRateLimitRequestsPerHour,
  getRepairMaxRounds,
  getRepairModelId,
  getTravelCapMinutes,
  getTurnstileSecretKey,
  resetConfig,
} from "../../src/models";

describe("Config module", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetConfig();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
  });

  describe("Defaults", () => {
    it("applies default model IDs", () => {
      assert.equal(getParsedModelId(), "claude-haiku-4.5");
      assert.equal(getPlanModelId(), "claude-sonnet-5");
      assert.equal(getRepairModelId(), "claude-sonnet-5");
      assert.equal(getAgentModelId(), "claude-sonnet-5");
    });

    it("applies default cache TTL", () => {
      assert.equal(getPlacesCacheTtlHours(), 24);
    });

    it("applies default rate limits", () => {
      assert.equal(getRateLimitRequestsPerHour(), 5);
      assert.equal(getRateLimitDailySpendUsd(), 100);
    });

    it("applies default validation caps", () => {
      assert.equal(getTravelCapMinutes(), 25);
      assert.equal(getAgentMaxToolCalls(), 6);
      assert.equal(getAgentMaxCostUsdPerTurn(), 0.03);
      assert.equal(getRepairMaxRounds(), 2);
    });
  });

  describe("Environment variable overrides", () => {
    it("overrides model IDs from environment", () => {
      process.env.PARSE_MODEL_ID = "claude-opus-5";
      process.env.PLAN_MODEL_ID = "claude-haiku-4.5";
      process.env.REPAIR_MODEL_ID = "claude-opus-5";
      process.env.AGENT_MODEL_ID = "claude-opus-5";

      assert.equal(getParsedModelId(), "claude-opus-5");
      assert.equal(getPlanModelId(), "claude-haiku-4.5");
      assert.equal(getRepairModelId(), "claude-opus-5");
      assert.equal(getAgentModelId(), "claude-opus-5");
    });

    it("overrides cache TTL from environment", () => {
      process.env.PLACES_CACHE_TTL_HOURS = "12";
      assert.equal(getPlacesCacheTtlHours(), 12);
    });

    it("overrides rate limits from environment", () => {
      process.env.RATE_LIMIT_REQUESTS_PER_HOUR = "10";
      process.env.RATE_LIMIT_DAILY_SPEND_USD = "200";

      assert.equal(getRateLimitRequestsPerHour(), 10);
      assert.equal(getRateLimitDailySpendUsd(), 200);
    });

    it("overrides validation caps from environment", () => {
      process.env.TRAVEL_CAP_MINUTES = "30";
      process.env.AGENT_MAX_TOOL_CALLS = "10";
      process.env.AGENT_MAX_COST_USD_PER_TURN = "0.05";
      process.env.REPAIR_MAX_ROUNDS = "3";

      assert.equal(getTravelCapMinutes(), 30);
      assert.equal(getAgentMaxToolCalls(), 10);
      assert.equal(getAgentMaxCostUsdPerTurn(), 0.05);
      assert.equal(getRepairMaxRounds(), 3);
    });
  });

  describe("API keys and secrets", () => {
    it("returns API key when set", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test123";
      assert.equal(getAnthropicApiKey(), "sk-ant-test123");
    });

    it("throws clear error when Anthropic API key is missing", () => {
      delete process.env.ANTHROPIC_API_KEY;

      assert.throws(
        () => getAnthropicApiKey(),
        {
          message: /Missing required secret: ANTHROPIC_API_KEY/,
        }
      );
    });

    it("throws clear error when Google Places API key is missing", () => {
      delete process.env.GOOGLE_PLACES_API_KEY;

      assert.throws(
        () => getGooglePlacesApiKey(),
        {
          message: /Missing required secret: GOOGLE_PLACES_API_KEY/,
        }
      );
    });

    it("throws clear error when Datadog API key is missing", () => {
      delete process.env.DATADOG_API_KEY;

      assert.throws(
        () => getDatadogApiKey(),
        {
          message: /Missing required secret: DATADOG_API_KEY/,
        }
      );
    });

    it("throws clear error when Turnstile secret key is missing", () => {
      delete process.env.TURNSTILE_SECRET_KEY;

      assert.throws(
        () => getTurnstileSecretKey(),
        {
          message: /Missing required secret: TURNSTILE_SECRET_KEY/,
        }
      );
    });

    it("allows getConfig to succeed even when secrets are missing", () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.GOOGLE_PLACES_API_KEY;

      // Should not throw - secrets are checked when accessed, not at load time
      const cfg = getConfig();
      assert.ok(cfg);
    });
  });

  describe("Invalid values", () => {
    it("rejects negative cache TTL", () => {
      process.env.PLACES_CACHE_TTL_HOURS = "-1";

      assert.throws(() => getConfig(), {
        name: "ZodError",
      });
    });

    it("rejects zero cache TTL", () => {
      process.env.PLACES_CACHE_TTL_HOURS = "0";

      assert.throws(() => getConfig(), {
        name: "ZodError",
      });
    });

    it("rejects negative rate limit", () => {
      process.env.RATE_LIMIT_REQUESTS_PER_HOUR = "-5";

      assert.throws(() => getConfig(), {
        name: "ZodError",
      });
    });

    it("rejects negative daily spend cap", () => {
      process.env.RATE_LIMIT_DAILY_SPEND_USD = "-100";

      assert.throws(() => getConfig(), {
        name: "ZodError",
      });
    });

    it("rejects negative travel cap", () => {
      process.env.TRAVEL_CAP_MINUTES = "-25";

      assert.throws(() => getConfig(), {
        name: "ZodError",
      });
    });

    it("rejects zero agent max tool calls", () => {
      process.env.AGENT_MAX_TOOL_CALLS = "0";

      assert.throws(() => getConfig(), {
        name: "ZodError",
      });
    });

    it("rejects empty model ID", () => {
      process.env.PARSE_MODEL_ID = "";

      assert.throws(() => getConfig(), {
        name: "ZodError",
      });
    });

    it("rejects non-numeric cache TTL", () => {
      process.env.PLACES_CACHE_TTL_HOURS = "not-a-number";

      assert.throws(() => getConfig(), {
        name: "ZodError",
      });
    });
  });

  describe("Config caching", () => {
    it("returns the same config instance on multiple calls", () => {
      process.env.PARSE_MODEL_ID = "claude-opus-5";

      const cfg1 = getConfig();
      const cfg2 = getConfig();

      assert.equal(cfg1, cfg2);
      assert.equal(cfg1.parseModelId, "claude-opus-5");
    });

    it("reloads config after reset", () => {
      process.env.PARSE_MODEL_ID = "claude-opus-5";
      assert.equal(getParsedModelId(), "claude-opus-5");

      resetConfig();
      process.env.PARSE_MODEL_ID = "claude-haiku-4.5";
      assert.equal(getParsedModelId(), "claude-haiku-4.5");
    });
  });
});
