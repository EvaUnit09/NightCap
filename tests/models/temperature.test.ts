import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { acceptsTemperature, getTemperatureFor, getTemperatureParamFor } from "../../src/models/temperature";
import { PIPELINE_STAGES, type PipelineStage } from "../../src/pipeline/prompt-loader";

describe("temperature configuration", () => {
  describe("getTemperatureFor", () => {
    it("should return 0 for parse_intent (deterministic)", () => {
      const temp = getTemperatureFor("parse_intent");
      assert.equal(temp, 0);
    });

    it("should return 1 for plan_itineraries (creative)", () => {
      const temp = getTemperatureFor("plan_itineraries");
      assert.equal(temp, 1);
    });

    it("should return 0.3 for repair_itinerary (focused)", () => {
      const temp = getTemperatureFor("repair_itinerary");
      assert.equal(temp, 0.3);
    });

    it("should return 0.5 for refine_agent (balanced)", () => {
      const temp = getTemperatureFor("refine_agent");
      assert.equal(temp, 0.5);
    });

    it("should return numbers between 0 and 1 for all stages", () => {
      for (const stage of PIPELINE_STAGES) {
        const temp = getTemperatureFor(stage);
        assert.ok(typeof temp === "number", `${stage} temp should be a number`);
        assert.ok(temp >= 0 && temp <= 1, `${stage} temp should be 0-1`);
      }
    });

    it("throws for an unknown runtime stage", () => {
      assert.throws(
        () => getTemperatureFor("unknown_stage" as PipelineStage),
        { message: /Unknown pipeline stage at runtime/ }
      );
    });
  });
});

describe("temperature capability", () => {
  it("accepts temperature on Haiku 4.5, including dated ids, and rejects Sonnet 5 and unknown models", () => {
    assert.equal(acceptsTemperature("claude-haiku-4-5"), true);
    assert.equal(acceptsTemperature("claude-haiku-4-5-20251001"), true);
    assert.equal(acceptsTemperature("claude-sonnet-5"), false);
    assert.equal(acceptsTemperature("claude-unknown"), false);
  });

  it("returns the stage temperature only for accepting models", () => {
    assert.equal(getTemperatureParamFor("parse_intent", "claude-haiku-4-5"), 0);
    assert.equal(getTemperatureParamFor("parse_intent", "claude-sonnet-5"), undefined);
    assert.equal(getTemperatureParamFor("plan_itineraries", "claude-sonnet-5"), undefined);
  });
});
