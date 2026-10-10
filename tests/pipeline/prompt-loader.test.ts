import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadPrompt,
  getPromptTraceTags,
  PIPELINE_STAGES,
  type PipelineStage,
} from "../../src/pipeline/prompt-loader";

describe("prompt-loader", () => {
  describe("loadPrompt", () => {
    it("should load parse_intent v1 prompt", () => {
      const prompt = loadPrompt("parse_intent", "v1");

      assert.equal(prompt.name, "parse_intent");
      assert.equal(prompt.version, "v1");
      assert.ok(prompt.text.length > 0, "prompt text should not be empty");
      assert.ok(
        prompt.text.includes("Parse Intent"),
        "prompt should contain title"
      );
      assert.equal(
        typeof prompt.contentHash,
        "string",
        "contentHash should be a string"
      );
      assert.equal(
        prompt.contentHash.length,
        16,
        "contentHash should be 16 chars"
      );
    });

    it("should load plan_itineraries v1 prompt", () => {
      const prompt = loadPrompt("plan_itineraries", "v1");

      assert.equal(prompt.name, "plan_itineraries");
      assert.equal(prompt.version, "v1");
      assert.ok(prompt.text.includes("Plan Itineraries"));
    });

    it("should load repair_itinerary v1 prompt", () => {
      const prompt = loadPrompt("repair_itinerary", "v1");

      assert.equal(prompt.name, "repair_itinerary");
      assert.equal(prompt.version, "v1");
      assert.ok(prompt.text.includes("Repair Itinerary"));
    });

    it("should load refine_agent v1 prompt", () => {
      const prompt = loadPrompt("refine_agent", "v1");

      assert.equal(prompt.name, "refine_agent");
      assert.equal(prompt.version, "v1");
      assert.ok(prompt.text.includes("Refine Agent"));
    });

    it("should parse front matter from prompt", () => {
      const prompt = loadPrompt("parse_intent", "v1");

      assert.equal(typeof prompt.frontMatter, "object");
      assert.equal(prompt.frontMatter.name, "parse_intent");
      assert.equal(prompt.frontMatter.version, "v1");
      assert.equal(prompt.frontMatter.model, "claude-haiku-4-5");
      assert.equal(prompt.frontMatter.temperature, 0);
      assert.equal(prompt.frontMatter.output_schema, "intentSchema");
    });

    it("should compute consistent content hash", () => {
      const prompt1 = loadPrompt("parse_intent", "v1");
      const prompt2 = loadPrompt("parse_intent", "v1");

      assert.equal(
        prompt1.contentHash,
        prompt2.contentHash,
        "same content should produce same hash"
      );
    });

    it("should produce different hashes for different prompts", () => {
      const prompt1 = loadPrompt("parse_intent", "v1");
      const prompt2 = loadPrompt("plan_itineraries", "v1");

      assert.notEqual(
        prompt1.contentHash,
        prompt2.contentHash,
        "different prompts should have different hashes"
      );
    });

    it("should throw error for non-existent prompt", () => {
      assert.throws(
        () => {
          loadPrompt("parse_intent" as PipelineStage, "v999");
        },
        {
          message: /Failed to load prompt: parse_intent\/v999\.md/,
        }
      );
    });

    it("should throw error for invalid stage", () => {
      assert.throws(
        () => {
          loadPrompt("invalid_stage" as PipelineStage, "v1");
        },
        {
          message: /Failed to load prompt/,
        }
      );
    });
  });

  describe("getPromptTraceTags", () => {
    it("should return trace tags for a prompt", () => {
      const prompt = loadPrompt("parse_intent", "v1");
      const tags = getPromptTraceTags(prompt);

      assert.equal(tags.prompt_name, "parse_intent");
      assert.equal(tags.prompt_version, "v1");
      assert.equal(tags.prompt_hash, prompt.contentHash);
      assert.equal(typeof tags.prompt_hash, "string");
    });

    it("should include all required tag fields", () => {
      const prompt = loadPrompt("plan_itineraries", "v1");
      const tags = getPromptTraceTags(prompt);

      assert.ok("prompt_name" in tags, "should have prompt_name");
      assert.ok("prompt_version" in tags, "should have prompt_version");
      assert.ok("prompt_hash" in tags, "should have prompt_hash");
    });
  });

  describe("PIPELINE_STAGES", () => {
    it("should export all pipeline stages", () => {
      assert.deepEqual(PIPELINE_STAGES, [
        "parse_intent",
        "plan_itineraries",
        "repair_itinerary",
        "refine_agent",
      ]);
    });

    it("should have corresponding prompt files for all stages", () => {
      for (const stage of PIPELINE_STAGES) {
        assert.doesNotThrow(
          () => {
            loadPrompt(stage, "v1");
          },
          `should load prompt for ${stage}`
        );
      }
    });
  });
});
