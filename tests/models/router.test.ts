import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getModelFor } from "../../src/models/router";
import { resetConfig } from "../../src/models/config";
import { PIPELINE_STAGES, type PipelineStage } from "../../src/pipeline/prompt-loader";

describe("model router", () => {
  beforeEach(() => {
    resetConfig();
  });

  describe("getModelFor", () => {
    it("should return Haiku 5.5 for parse_intent by default", () => {
      const modelId = getModelFor("parse_intent");
      assert.equal(modelId, "claude-haiku-5-5");
    });

    it("should return Haiku 5.5 for plan_itineraries by default", () => {
      const modelId = getModelFor("plan_itineraries");
      assert.equal(modelId, "claude-haiku-5-5");
    });

    it("should return Haiku 5.5 for repair_itinerary by default", () => {
      const modelId = getModelFor("repair_itinerary");
      assert.equal(modelId, "claude-haiku-5-5");
    });

    it("should return Haiku 5.5 for refine_agent by default", () => {
      const modelId = getModelFor("refine_agent");
      assert.equal(modelId, "claude-haiku-5-5");
    });

    it("should respect PARSE_MODEL_ID env override", () => {
      const original = process.env.PARSE_MODEL_ID;
      try {
        process.env.PARSE_MODEL_ID = "claude-opus-5";
        resetConfig();

        const modelId = getModelFor("parse_intent");
        assert.equal(modelId, "claude-opus-5");
      } finally {
        if (original === undefined) {
          delete process.env.PARSE_MODEL_ID;
        } else {
          process.env.PARSE_MODEL_ID = original;
        }
        resetConfig();
      }
    });

    it("should respect PLAN_MODEL_ID env override", () => {
      const original = process.env.PLAN_MODEL_ID;
      try {
        process.env.PLAN_MODEL_ID = "claude-haiku-4-5";
        resetConfig();

        const modelId = getModelFor("plan_itineraries");
        assert.equal(modelId, "claude-haiku-4-5");
      } finally {
        if (original === undefined) {
          delete process.env.PLAN_MODEL_ID;
        } else {
          process.env.PLAN_MODEL_ID = original;
        }
        resetConfig();
      }
    });

    it("should respect REPAIR_MODEL_ID env override", () => {
      const original = process.env.REPAIR_MODEL_ID;
      try {
        process.env.REPAIR_MODEL_ID = "claude-opus-5";
        resetConfig();

        const modelId = getModelFor("repair_itinerary");
        assert.equal(modelId, "claude-opus-5");
      } finally {
        if (original === undefined) {
          delete process.env.REPAIR_MODEL_ID;
        } else {
          process.env.REPAIR_MODEL_ID = original;
        }
        resetConfig();
      }
    });

    it("should respect AGENT_MODEL_ID env override", () => {
      const original = process.env.AGENT_MODEL_ID;
      try {
        process.env.AGENT_MODEL_ID = "claude-opus-5";
        resetConfig();

        const modelId = getModelFor("refine_agent");
        assert.equal(modelId, "claude-opus-5");
      } finally {
        if (original === undefined) {
          delete process.env.AGENT_MODEL_ID;
        } else {
          process.env.AGENT_MODEL_ID = original;
        }
        resetConfig();
      }
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
      const original = process.env.PARSE_MODEL_ID;
      try {
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
      } finally {
        if (original === undefined) {
          delete process.env.PARSE_MODEL_ID;
        } else {
          process.env.PARSE_MODEL_ID = original;
        }
        resetConfig();
      }
    });
  });

  describe("stage-to-config-getter mapping", () => {
    it("should map parse_intent to getParseModelId", () => {
      const original = process.env.PARSE_MODEL_ID;
      try {
        process.env.PARSE_MODEL_ID = "test-parse-model";
        resetConfig();

        const modelId = getModelFor("parse_intent");
        assert.equal(modelId, "test-parse-model", "should use getParseModelId");
      } finally {
        if (original === undefined) {
          delete process.env.PARSE_MODEL_ID;
        } else {
          process.env.PARSE_MODEL_ID = original;
        }
        resetConfig();
      }
    });

    it("should map plan_itineraries to getPlanModelId", () => {
      const original = process.env.PLAN_MODEL_ID;
      try {
        process.env.PLAN_MODEL_ID = "test-plan-model";
        resetConfig();

        const modelId = getModelFor("plan_itineraries");
        assert.equal(modelId, "test-plan-model", "should use getPlanModelId");
      } finally {
        if (original === undefined) {
          delete process.env.PLAN_MODEL_ID;
        } else {
          process.env.PLAN_MODEL_ID = original;
        }
        resetConfig();
      }
    });

    it("should map repair_itinerary to getRepairModelId", () => {
      const original = process.env.REPAIR_MODEL_ID;
      try {
        process.env.REPAIR_MODEL_ID = "test-repair-model";
        resetConfig();

        const modelId = getModelFor("repair_itinerary");
        assert.equal(modelId, "test-repair-model", "should use getRepairModelId");
      } finally {
        if (original === undefined) {
          delete process.env.REPAIR_MODEL_ID;
        } else {
          process.env.REPAIR_MODEL_ID = original;
        }
        resetConfig();
      }
    });

    it("should map refine_agent to getAgentModelId", () => {
      const original = process.env.AGENT_MODEL_ID;
      try {
        process.env.AGENT_MODEL_ID = "test-agent-model";
        resetConfig();

        const modelId = getModelFor("refine_agent");
        assert.equal(modelId, "test-agent-model", "should use getAgentModelId");
      } finally {
        if (original === undefined) {
          delete process.env.AGENT_MODEL_ID;
        } else {
          process.env.AGENT_MODEL_ID = original;
        }
        resetConfig();
      }
    });
  });

  describe("exhaustive switch with never default", () => {
    it("should handle unknown stage at runtime", () => {
      const unknownStage = "unknown_stage" as PipelineStage;

      assert.throws(
        () => {
          getModelFor(unknownStage);
        },
        {
          message: /Unknown pipeline stage at runtime/,
        },
        "Should throw for unknown stage even when type-casted"
      );
    });
  });
});
