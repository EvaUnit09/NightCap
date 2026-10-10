import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getModelFor } from "../../src/models/router";
import { resetConfig } from "../../src/models/config";
import { PIPELINE_STAGES } from "../../src/pipeline/prompt-loader";

describe("model router", () => {
  beforeEach(() => {
    resetConfig();
  });

  describe("getModelFor", () => {
    it("should return Haiku 4.5 for parse_intent by default", () => {
      const modelId = getModelFor("parse_intent");
      assert.equal(modelId, "claude-haiku-4-5");
    });

    it("should return Sonnet 5 for plan_itineraries by default", () => {
      const modelId = getModelFor("plan_itineraries");
      assert.equal(modelId, "claude-sonnet-5");
    });

    it("should return Sonnet 5 for repair_itinerary by default", () => {
      const modelId = getModelFor("repair_itinerary");
      assert.equal(modelId, "claude-sonnet-5");
    });

    it("should return Sonnet 5 for refine_agent by default", () => {
      const modelId = getModelFor("refine_agent");
      assert.equal(modelId, "claude-sonnet-5");
    });

    it("should respect PARSE_MODEL_ID env override", () => {
      process.env.PARSE_MODEL_ID = "claude-opus-5";
      resetConfig();

      const modelId = getModelFor("parse_intent");
      assert.equal(modelId, "claude-opus-5");

      delete process.env.PARSE_MODEL_ID;
    });

    it("should respect PLAN_MODEL_ID env override", () => {
      process.env.PLAN_MODEL_ID = "claude-haiku-4-5";
      resetConfig();

      const modelId = getModelFor("plan_itineraries");
      assert.equal(modelId, "claude-haiku-4-5");

      delete process.env.PLAN_MODEL_ID;
    });

    it("should respect REPAIR_MODEL_ID env override", () => {
      process.env.REPAIR_MODEL_ID = "claude-opus-5";
      resetConfig();

      const modelId = getModelFor("repair_itinerary");
      assert.equal(modelId, "claude-opus-5");

      delete process.env.REPAIR_MODEL_ID;
    });

    it("should respect AGENT_MODEL_ID env override", () => {
      process.env.AGENT_MODEL_ID = "claude-opus-5";
      resetConfig();

      const modelId = getModelFor("refine_agent");
      assert.equal(modelId, "claude-opus-5");

      delete process.env.AGENT_MODEL_ID;
    });

    it("should handle all pipeline stages", () => {
      for (const stage of PIPELINE_STAGES) {
        const modelId = getModelFor(stage);
        assert.ok(
          typeof modelId === "string" && modelId.length > 0,
          `should return a model ID for stage ${stage}`
        );
      }
    });

    it("should return non-empty model IDs for all stages", () => {
      const stages = PIPELINE_STAGES;
      const modelIds = stages.map((stage) => getModelFor(stage));

      for (const modelId of modelIds) {
        assert.ok(modelId.length > 0, "model ID should not be empty");
      }
    });

    it("should use config getters and not hardcode values", () => {
      // Test that changing env vars affects the router
      const originalParseModel = getModelFor("parse_intent");

      process.env.PARSE_MODEL_ID = "test-model-override";
      resetConfig();

      const newParseModel = getModelFor("parse_intent");
      assert.notEqual(
        originalParseModel,
        newParseModel,
        "router should use config getters, not hardcoded values"
      );

      delete process.env.PARSE_MODEL_ID;
      resetConfig();
    });
  });

  describe("static routing", () => {
    it("should not implement dynamic routing", () => {
      // getModelFor should be a simple switch/map, not a complex router
      // Verify by checking that the same stage always returns the same model
      // (given the same config)
      const modelId1 = getModelFor("parse_intent");
      const modelId2 = getModelFor("parse_intent");
      const modelId3 = getModelFor("parse_intent");

      assert.equal(modelId1, modelId2);
      assert.equal(modelId2, modelId3);
    });

    it("should route parse to Haiku and others to Sonnet by default", () => {
      const parseModel = getModelFor("parse_intent");
      const planModel = getModelFor("plan_itineraries");
      const repairModel = getModelFor("repair_itinerary");
      const agentModel = getModelFor("refine_agent");

      assert.ok(parseModel.includes("haiku"), "parse should use Haiku");
      assert.ok(planModel.includes("sonnet"), "plan should use Sonnet");
      assert.ok(repairModel.includes("sonnet"), "repair should use Sonnet");
      assert.ok(agentModel.includes("sonnet"), "agent should use Sonnet");
    });
  });
});
