import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  getAgentMaxCostUsdPerTurn,
  getAgentMaxToolCalls,
  getRepairMaxRounds,
  getTravelCapMinutes,
  resetConfig,
} from "../../src/models/config";
import {
  PIPELINE_STAGES,
  PROMPT_SCHEMA_BOUNDS,
  clearPromptCache,
  getPromptTraceTags,
  loadPrompt,
  type PipelineStage,
} from "../../src/pipeline/prompt-loader";
import {
  ITINERARY_OPTIONS_MAX,
  ITINERARY_OPTIONS_MIN,
  STOPS_MAX,
  STOPS_MIN,
  itineraryOptionSchema,
  itinerarySchema,
} from "../../src/validation/itinerary";
import type { Itinerary, Stop } from "../../src/validation";

const FIXTURE_VERSION = "v2";

let fixtureRoot: string;

function writeFixture(contents: string): void {
  const dir = join(fixtureRoot, "parse_intent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${FIXTURE_VERSION}.md`), contents, "utf-8");
  clearPromptCache();
}

function loadFixture() {
  return loadPrompt("parse_intent", FIXTURE_VERSION, { promptsRoot: fixtureRoot });
}

describe("prompt-loader", () => {
  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "nightcap-prompts-"));
    clearPromptCache();
    resetConfig();
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    resetConfig();
    clearPromptCache();
  });

  describe("loadPrompt", () => {
    it("should load parse_intent v1 prompt", () => {
      const prompt = loadPrompt("parse_intent", "v1");

      assert.equal(prompt.name, "parse_intent");
      assert.equal(prompt.version, "v1");
      assert.ok(prompt.text.length > 0, "prompt text should not be empty");
      assert.ok(prompt.text.startsWith("---"), "text should include front matter");
      assert.ok(prompt.body.length > 0, "prompt body should not be empty");
      assert.ok(!prompt.body.startsWith("---"), "body should omit front matter");
      assert.ok(prompt.body.includes("Parse Intent"), "body should contain prompt content");
      assert.equal(typeof prompt.contentHash, "string");
      assert.equal(prompt.contentHash.length, 16);
    });

    it("should load plan_itineraries v1 prompt", () => {
      const prompt = loadPrompt("plan_itineraries", "v1");
      assert.equal(prompt.name, "plan_itineraries");
      assert.ok(prompt.body.includes("Plan Itineraries"));
    });

    it("should load repair_itinerary v1 prompt", () => {
      const prompt = loadPrompt("repair_itinerary", "v1");
      assert.equal(prompt.name, "repair_itinerary");
      assert.ok(prompt.body.includes("Repair Itinerary"));
    });

    it("should load refine_agent v1 prompt", () => {
      const prompt = loadPrompt("refine_agent", "v1");
      assert.equal(prompt.name, "refine_agent");
      assert.ok(prompt.body.includes("Refine Agent"));
    });

    it("should parse front matter from prompt", () => {
      const prompt = loadPrompt("parse_intent", "v1");

      assert.equal(prompt.frontMatter.name, "parse_intent");
      assert.equal(prompt.frontMatter.version, "v1");
      assert.equal(
        "model" in prompt.frontMatter,
        false,
        "model should not be in front matter"
      );
    });

    it("should compute consistent content hash", () => {
      const prompt1 = loadPrompt("parse_intent", "v1");
      const prompt2 = loadPrompt("parse_intent", "v1");
      assert.equal(prompt1.contentHash, prompt2.contentHash);
    });

    it("should produce different hashes for different prompts", () => {
      const prompt1 = loadPrompt("parse_intent", "v1");
      const prompt2 = loadPrompt("plan_itineraries", "v1");
      assert.notEqual(prompt1.contentHash, prompt2.contentHash);
    });

    it("normalizes CRLF before hashing", () => {
      const lf = "---\nname: parse_intent\nversion: v2\n---\n# Body {{min_stops}}\n";
      writeFixture(lf);
      const hashLf = loadFixture().contentHash;

      writeFixture(lf.replace(/\n/g, "\r\n"));
      const hashCrlf = loadFixture().contentHash;

      assert.equal(hashLf, hashCrlf);
    });

    it("memoizes loadPrompt for the same stage and version", () => {
      const first = loadPrompt("parse_intent", "v1");
      const second = loadPrompt("parse_intent", "v1");
      assert.equal(first, second);
    });

    it("should throw error for non-existent prompt", () => {
      assert.throws(
        () => {
          loadPrompt("parse_intent", "v2");
        },
        { message: /Failed to load prompt: parse_intent\/v2\.md/ }
      );
    });

    it("should throw error for invalid stage", () => {
      assert.throws(
        () => {
          loadPrompt("invalid_stage" as PipelineStage, "v1");
        },
        { message: /Invalid stage/ }
      );
    });
  });

  describe("front-matter parsing", () => {
    it("throws when the closing --- is missing", () => {
      writeFixture("---\nname: parse_intent\nversion: v2\n# no closer\n");
      assert.throws(() => loadFixture(), { message: /Missing or malformed front matter/ });
    });

    it("throws on a malformed front-matter line without echoing the line", () => {
      writeFixture("---\nname: parse_intent\nnot-a-pair\nversion: v2\n---\n# Body\n");
      assert.throws(() => loadFixture(), (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /Malformed front matter/);
        assert.equal(message.includes("not-a-pair"), false);
        return true;
      });
    });

    it("throws when name or version is missing", () => {
      writeFixture("---\nname: parse_intent\n---\n# Body\n");
      assert.throws(() => loadFixture(), { message: /must include name and version/ });
    });

    it("throws when front-matter name does not match the path", () => {
      writeFixture("---\nname: plan_itineraries\nversion: v2\n---\n# Body\n");
      assert.throws(() => loadFixture(), (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /does not match stage/);
        assert.equal(message.includes("plan_itineraries"), false);
        return true;
      });
    });

    it("throws when front-matter version does not match the path", () => {
      writeFixture("---\nname: parse_intent\nversion: v1\n---\n# Body\n");
      assert.throws(() => loadFixture(), { message: /does not match requested version/ });
    });

    it("throws on unsupported front-matter keys without echoing the key", () => {
      writeFixture(
        "---\nname: parse_intent\nversion: v2\nmodel: claude-haiku-4-5\n---\n# Body\n"
      );
      assert.throws(() => loadFixture(), (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /Unsupported front-matter key/);
        assert.equal(message.includes("model"), false);
        return true;
      });
    });

    it("throws on duplicate front-matter keys", () => {
      writeFixture(
        "---\nname: parse_intent\nname: parse_intent\nversion: v2\n---\n# Body\n"
      );
      assert.throws(() => loadFixture(), { message: /Duplicate front-matter key/ });
    });

    it("throws on an unknown placeholder without echoing the token", () => {
      writeFixture("---\nname: parse_intent\nversion: v2\n---\nUse {{not_a_real_key}}\n");
      assert.throws(() => loadFixture(), (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /unknown placeholder/);
        assert.equal(message.includes("not_a_real_key"), false);
        return true;
      });
    });

    it("throws on {{constructor}} instead of reading Object.prototype", () => {
      writeFixture("---\nname: parse_intent\nversion: v2\n---\nUse {{constructor}}\n");
      assert.throws(() => loadFixture(), { message: /unknown placeholder/ });
    });
  });

  describe("templating", () => {
    it("substitutes config and schema bounds into the body", () => {
      const plan = loadPrompt("plan_itineraries", "v1");
      const repair = loadPrompt("repair_itinerary", "v1");
      const agent = loadPrompt("refine_agent", "v1");
      const parse = loadPrompt("parse_intent", "v1");

      assert.match(plan.text, /\{\{travel_cap_minutes\}\}/);
      assert.match(plan.text, /\{\{min_options\}\}/);
      assert.match(agent.text, /\{\{agent_max_tool_calls\}\}/);
      assert.match(agent.text, /\{\{agent_max_cost_usd\}\}/);

      assert.ok(plan.body.includes(String(getTravelCapMinutes())));
      assert.ok(plan.body.includes(`${PROMPT_SCHEMA_BOUNDS.minOptions}–${PROMPT_SCHEMA_BOUNDS.maxOptions}`));
      assert.ok(parse.body.includes(`${PROMPT_SCHEMA_BOUNDS.minStops}–${PROMPT_SCHEMA_BOUNDS.maxStops}`));
      assert.ok(parse.body.includes(PROMPT_SCHEMA_BOUNDS.stopTypes.join(", ")));
      assert.ok(parse.body.includes(String(PROMPT_SCHEMA_BOUNDS.tagMax)));
      assert.ok(repair.body.includes(String(getRepairMaxRounds())));
      assert.ok(agent.body.includes(String(getAgentMaxToolCalls())));
      assert.ok(agent.body.includes(String(getAgentMaxCostUsdPerTurn())));
      assert.equal(plan.body.includes("{{"), false);
    });

    it("keeps schema bounds aligned with the itinerary Zod contracts", () => {
      const start = "2026-10-10T19:00:00-04:00";
      const mid = "2026-10-10T20:30:00-04:00";
      const later = "2026-10-10T21:00:00-04:00";
      const end = "2026-10-10T22:30:00-04:00";

      function stop(placeId: string, travel: Stop["travelToNext"]): Stop {
        return {
          placeId,
          name: placeId,
          start: travel ? start : later,
          end: travel ? mid : end,
          estimatedCostUsd: 40,
          why: "Quiet room and a short walk.",
          travelToNext: travel,
        };
      }

      const twoStop = [stop("a", { mode: "walk", minutes: 10 }), stop("b", null)];
      assert.equal(itineraryOptionSchema.safeParse({ theme: "Two", stops: twoStop }).success, true);
      assert.equal(
        itineraryOptionSchema.safeParse({ theme: "One", stops: [twoStop[0]] }).success,
        false
      );

      const itinerary: Itinerary = {
        singleStop: false,
        options: [
          { theme: "One", stops: twoStop },
          { theme: "Two", stops: [stop("c", { mode: "walk", minutes: 10 }), stop("d", null)] },
        ],
      };
      assert.equal(itinerarySchema.safeParse(itinerary).success, true);
      assert.equal(
        itinerarySchema.safeParse({ options: [itinerary.options[0]] }).success,
        false
      );
      assert.equal(PROMPT_SCHEMA_BOUNDS.minOptions, ITINERARY_OPTIONS_MIN);
      assert.equal(PROMPT_SCHEMA_BOUNDS.maxOptions, ITINERARY_OPTIONS_MAX);
      assert.equal(PROMPT_SCHEMA_BOUNDS.minStops, STOPS_MIN);
      assert.equal(PROMPT_SCHEMA_BOUNDS.maxStops, STOPS_MAX);
    });
  });

  describe("getPromptTraceTags", () => {
    it("should return trace tags for a prompt", () => {
      const prompt = loadPrompt("parse_intent", "v1");
      const tags = getPromptTraceTags(prompt);

      assert.equal(tags.prompt_name, "parse_intent");
      assert.equal(tags.prompt_version, "v1");
      assert.equal(tags.prompt_hash, prompt.contentHash);
      assert.equal(typeof tags.prompt_rendered_hash, "string");
      assert.equal(tags.prompt_rendered_hash.length, 16);
    });

    it("should include all required tag fields", () => {
      const tags = getPromptTraceTags(loadPrompt("plan_itineraries", "v1"));
      assert.ok("prompt_name" in tags);
      assert.ok("prompt_version" in tags);
      assert.ok("prompt_hash" in tags);
      assert.ok("prompt_rendered_hash" in tags);
    });

    it("keeps prompt_hash stable and changes prompt_rendered_hash when TRAVEL_CAP_MINUTES changes", () => {
      const original = process.env.TRAVEL_CAP_MINUTES;
      try {
        delete process.env.TRAVEL_CAP_MINUTES;
        resetConfig();
        clearPromptCache();
        const baseline = getPromptTraceTags(loadPrompt("plan_itineraries", "v1"));

        process.env.TRAVEL_CAP_MINUTES = "99";
        resetConfig();
        clearPromptCache();
        const overridden = getPromptTraceTags(loadPrompt("plan_itineraries", "v1"));

        assert.equal(baseline.prompt_hash, overridden.prompt_hash);
        assert.notEqual(baseline.prompt_rendered_hash, overridden.prompt_rendered_hash);
        assert.ok(loadPrompt("plan_itineraries", "v1").body.includes("99"));
      } finally {
        if (original === undefined) {
          delete process.env.TRAVEL_CAP_MINUTES;
        } else {
          process.env.TRAVEL_CAP_MINUTES = original;
        }
        resetConfig();
        clearPromptCache();
      }
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
        assert.doesNotThrow(() => {
          loadPrompt(stage, "v1");
        });
      }
    });
  });
});
