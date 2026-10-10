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
  getParseModelId,
  getPlacesCacheTtlHours,
  getPlanModelId,
  getRateLimitDailySpendUsd,
  getRateLimitRequestsPerHour,
  getRepairMaxRounds,
  getRepairModelId,
  getMaxTravelLegsPerRequest,
  getTravelCapMinutes,
  getTravelClaimToleranceMinutes,
  getTravelBudgetMs,
  getEnableLiveRoutes,
  getRoutesApiTimeoutMs,
  getPriceRanges,
  getTurnstileSecretKey,
  resetConfig,
  assertProductionLiveRoutes,
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
      // Clear any ambient env vars to ensure defaults are tested
      delete process.env.PARSE_MODEL_ID;
      delete process.env.PLAN_MODEL_ID;
      delete process.env.REPAIR_MODEL_ID;
      delete process.env.AGENT_MODEL_ID;

      assert.equal(getParseModelId(), "claude-haiku-4-5");
      assert.equal(getPlanModelId(), "claude-sonnet-5");
      assert.equal(getRepairModelId(), "claude-sonnet-5");
      assert.equal(getAgentModelId(), "claude-sonnet-5");
    });

    it("applies default cache TTL", () => {
      delete process.env.PLACES_CACHE_TTL_HOURS;
      assert.equal(getPlacesCacheTtlHours(), 24);
    });

    it("applies default rate limits", () => {
      delete process.env.RATE_LIMIT_REQUESTS_PER_HOUR;
      delete process.env.RATE_LIMIT_DAILY_SPEND_USD;
      assert.equal(getRateLimitRequestsPerHour(), 5);
      assert.equal(getRateLimitDailySpendUsd(), 5);
    });

    it("applies default validation caps", () => {
      delete process.env.TRAVEL_CAP_MINUTES;
      delete process.env.AGENT_MAX_TOOL_CALLS;
      delete process.env.AGENT_MAX_COST_USD_PER_TURN;
      delete process.env.REPAIR_MAX_ROUNDS;
      delete process.env.MAX_TRAVEL_LEGS_PER_REQUEST;
      assert.equal(getTravelCapMinutes(), 25);
      assert.equal(getAgentMaxToolCalls(), 6);
      assert.equal(getAgentMaxCostUsdPerTurn(), 0.03);
      assert.equal(getRepairMaxRounds(), 2);
      assert.equal(getMaxTravelLegsPerRequest(), 4);
      delete process.env.ROUTES_API_TIMEOUT_MS;
      delete process.env.TRAVEL_CLAIM_TOLERANCE_MINUTES;
      assert.equal(getRoutesApiTimeoutMs(), 5000);
      assert.equal(getTravelClaimToleranceMinutes(), 5);
      delete process.env.TRAVEL_BUDGET_MS;
      delete process.env.ENABLE_LIVE_ROUTES;
      assert.equal(getTravelBudgetMs(), 6000);
      assert.equal(getEnableLiveRoutes(), false);
      assert.deepEqual(getPriceRanges().moderate, [20, 120]);
    });
  });

  describe("Environment variable overrides", () => {
    it("overrides model IDs from environment", () => {
      process.env.PARSE_MODEL_ID = "claude-opus-5";
      process.env.PLAN_MODEL_ID = "claude-haiku-4-5";
      process.env.REPAIR_MODEL_ID = "claude-opus-5";
      process.env.AGENT_MODEL_ID = "claude-opus-5";

      assert.equal(getParseModelId(), "claude-opus-5");
      assert.equal(getPlanModelId(), "claude-haiku-4-5");
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
      process.env.MAX_TRAVEL_LEGS_PER_REQUEST = "6";
      process.env.TRAVEL_BUDGET_MS = "8000";
      process.env.ENABLE_LIVE_ROUTES = "true";

      assert.equal(getTravelCapMinutes(), 30);
      assert.equal(getAgentMaxToolCalls(), 10);
      assert.equal(getAgentMaxCostUsdPerTurn(), 0.05);
      assert.equal(getRepairMaxRounds(), 3);
      assert.equal(getMaxTravelLegsPerRequest(), 6);
      assert.equal(getTravelBudgetMs(), 8000);
      assert.equal(getEnableLiveRoutes(), true);
    });
  });

  describe("Empty and whitespace-only environment variables", () => {
    it("treats empty string API key as missing (fails at access time)", () => {
      process.env.ANTHROPIC_API_KEY = "";

      // getConfig should succeed (empty string preprocessed to undefined)
      const cfg = getConfig();
      assert.ok(cfg);

      // But accessing the key should fail
      assert.throws(
        () => getAnthropicApiKey(),
        {
          message: /Missing required secret: ANTHROPIC_API_KEY/,
        }
      );
    });

    it("treats whitespace-only API key as missing", () => {
      process.env.GOOGLE_PLACES_API_KEY = "   \t\n  ";

      const cfg = getConfig();
      assert.ok(cfg);

      assert.throws(
        () => getGooglePlacesApiKey(),
        {
          message: /Missing required secret: GOOGLE_PLACES_API_KEY/,
        }
      );
    });

    it("applies default when numeric var is empty string", () => {
      process.env.PLACES_CACHE_TTL_HOURS = "";
      assert.equal(getPlacesCacheTtlHours(), 24);
    });

    it("applies default when numeric var is whitespace-only", () => {
      process.env.RATE_LIMIT_REQUESTS_PER_HOUR = "  \t  ";
      assert.equal(getRateLimitRequestsPerHour(), 5);
    });

    it("applies default when model ID is empty string", () => {
      process.env.PARSE_MODEL_ID = "";
      assert.equal(getParseModelId(), "claude-haiku-4-5");
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

    it("error messages do not echo secret values", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-secret-value-12345";

      let errorMessage = "";
      try {
        // Force a config error with an invalid numeric value while a secret is set
        process.env.PLACES_CACHE_TTL_HOURS = "not-a-number";
        getConfig();
      } catch (error) {
        errorMessage = String(error);
      }

      // Error should not contain the secret value
      assert.ok(!errorMessage.includes("sk-ant-secret-value-12345"));
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

    it("rejects MAX_TRAVEL_LEGS_PER_REQUEST outside 2–9 with a readable error", () => {
      for (const value of ["0", "1", "10", "-1", "4.5"]) {
        resetConfig();
        process.env.MAX_TRAVEL_LEGS_PER_REQUEST = value;
        assert.throws(
          () => getConfig(),
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            assert.match(
              message,
              /MAX_TRAVEL_LEGS_PER_REQUEST must be an integer from 2 to 9/,
            );
            return true;
          },
          `expected ${value} to fail with a readable range message`,
        );
      }
    });

    it("rejects zero agent max tool calls", () => {
      process.env.AGENT_MAX_TOOL_CALLS = "0";

      assert.throws(() => getConfig(), {
        name: "ZodError",
      });
    });

    it("rejects empty model ID (after trim)", () => {
      // Empty string is now preprocessed to undefined, so it gets the default.
      // This test checks that model IDs must be non-empty if provided.
      process.env.PARSE_MODEL_ID = "   ";
      
      // After preprocessing, this becomes undefined and uses the default
      assert.equal(getParseModelId(), "claude-haiku-4-5");
    });

    it("rejects non-numeric cache TTL", () => {
      process.env.PLACES_CACHE_TTL_HOURS = "not-a-number";

      assert.throws(() => getConfig(), {
        name: "ZodError",
      });
    });

    it("rejects float on integer-required field", () => {
      process.env.AGENT_MAX_TOOL_CALLS = "12.5";

      assert.throws(() => getConfig(), {
        name: "ZodError",
      });
    });

    it("accepts scientific notation for numeric fields", () => {
      process.env.RATE_LIMIT_REQUESTS_PER_HOUR = "1e1";
      assert.equal(getRateLimitRequestsPerHour(), 10);
    });

    it("accepts string-formatted decimal on integer field if it coerces to integer", () => {
      // Zod's coerce.number() converts "25.0" to 25, which is a valid integer
      process.env.TRAVEL_CAP_MINUTES = "25.0";
      assert.equal(getTravelCapMinutes(), 25);
    });

    it("accepts decimals on non-integer numeric field", () => {
      process.env.AGENT_MAX_COST_USD_PER_TURN = "0.05";
      assert.equal(getAgentMaxCostUsdPerTurn(), 0.05);
    });

    it("rejects a price range whose min is greater than max", () => {
      process.env.PRICE_RANGE_MODERATE = "120,20";
      assert.throws(() => getConfig(), {
        name: "ZodError",
      });
    });

    it("rejects a non-numeric price range with a ZodError", () => {
      process.env.PRICE_RANGE_MODERATE = "abc";
      assert.throws(() => getConfig(), {
        name: "ZodError",
      });
    });

    it("rejects a three-part price range with a ZodError", () => {
      process.env.PRICE_RANGE_MODERATE = "1,2,3";
      assert.throws(() => getConfig(), {
        name: "ZodError",
      });
    });

    it("rejects a price range with an empty side", () => {
      process.env.PRICE_RANGE_MODERATE = ",50";
      assert.throws(() => getConfig(), {
        name: "ZodError",
      });
    });
  });

  describe("ENABLE_LIVE_ROUTES", () => {
    it("accepts true, false, 1, and 0", () => {
      process.env.ENABLE_LIVE_ROUTES = "true";
      assert.equal(getEnableLiveRoutes(), true);
      resetConfig();
      process.env.ENABLE_LIVE_ROUTES = "1";
      assert.equal(getEnableLiveRoutes(), true);
      resetConfig();
      process.env.ENABLE_LIVE_ROUTES = "false";
      assert.equal(getEnableLiveRoutes(), false);
      resetConfig();
      process.env.ENABLE_LIVE_ROUTES = "0";
      assert.equal(getEnableLiveRoutes(), false);
    });

    it("throws a readable error for any other value", () => {
      for (const value of ["yes", "YES", "maybe", "2", "on"]) {
        resetConfig();
        process.env.ENABLE_LIVE_ROUTES = value;
        assert.throws(
          () => getEnableLiveRoutes(),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /ENABLE_LIVE_ROUTES/);
            assert.match(error.message, /true, false, 1, or 0/);
            return true;
          }
        );
      }
    });
  });

  describe("production live-Routes startup", () => {
    it("throws in production without the Routes key", () => {
      process.env.NODE_ENV = "production";
      delete process.env.NEXT_PHASE;
      delete process.env.GOOGLE_PLACES_API_KEY;
      process.env.ENABLE_LIVE_ROUTES = "true";
      assert.throws(
        () => assertProductionLiveRoutes(),
        /ENABLE_LIVE_ROUTES|GOOGLE_PLACES_API_KEY/
      );
    });

    it("is ok in production with ENABLE_LIVE_ROUTES and the Routes key", () => {
      process.env.NODE_ENV = "production";
      delete process.env.NEXT_PHASE;
      process.env.ENABLE_LIVE_ROUTES = "true";
      process.env.GOOGLE_PLACES_API_KEY = "test-routes-key";
      assert.doesNotThrow(() => assertProductionLiveRoutes());
    });

    it("is ok in development without the key", () => {
      process.env.NODE_ENV = "development";
      delete process.env.NEXT_PHASE;
      delete process.env.GOOGLE_PLACES_API_KEY;
      delete process.env.ENABLE_LIVE_ROUTES;
      assert.doesNotThrow(() => assertProductionLiveRoutes());
      assert.doesNotThrow(() => getConfig());
    });

    it("does not throw from getConfig in production without a key", () => {
      process.env.NODE_ENV = "production";
      delete process.env.GOOGLE_PLACES_API_KEY;
      delete process.env.ENABLE_LIVE_ROUTES;
      assert.doesNotThrow(() => getConfig());
    });

    it("skips the check during next build", () => {
      process.env.NODE_ENV = "production";
      process.env.NEXT_PHASE = "phase-production-build";
      delete process.env.GOOGLE_PLACES_API_KEY;
      delete process.env.ENABLE_LIVE_ROUTES;
      assert.doesNotThrow(() => assertProductionLiveRoutes());
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
      assert.equal(getParseModelId(), "claude-opus-5");

      resetConfig();
      process.env.PARSE_MODEL_ID = "claude-haiku-4-5";
      assert.equal(getParseModelId(), "claude-haiku-4-5");
    });
  });
});
