import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PIPELINE_STAGES, loadPrompt } from "../../src/pipeline/prompt-loader";
import {
  BYPASS_FENCE_VARIANTS,
  bypassDocument,
  collectJsonFenceFailures,
  extractFencedBlocks,
} from "./prompt-json-blocks";

describe("prompt JSON fence bypasses", () => {
  for (const variant of BYPASS_FENCE_VARIANTS) {
    it(`fails on ${variant.name} with an invalid taxi itinerary`, () => {
      const failures = collectJsonFenceFailures(
        bypassDocument(variant.open, variant.close)
      );
      assert.ok(
        failures.length > 0,
        `expected ${variant.name} to be rejected`
      );
    });
  }
});

describe("plan example candidates", () => {
  it("only uses placeIds that appear in candidate blocks", () => {
    const body = loadPrompt("plan_itineraries", "v1").body;
    const blocks = extractFencedBlocks(body);
    const candidateIds = new Set<string>();
    const itineraryIds: string[] = [];

    for (const block of blocks) {
      const parsed = JSON.parse(block.blockText) as Record<string, unknown>;
      if (block.schemaName === "candidate" && typeof parsed.placeId === "string") {
        candidateIds.add(parsed.placeId);
      }
      if (block.schemaName === "itinerary") {
        const itinerary = parsed as {
          options: Array<{ stops: Array<{ placeId: string }> }>;
        };
        for (const option of itinerary.options) {
          for (const stop of option.stops) {
            itineraryIds.push(stop.placeId);
          }
        }
      }
    }

    assert.ok(candidateIds.size >= 2, "expected candidate examples");
    assert.ok(itineraryIds.length >= 2, "expected itinerary stops");
    for (const placeId of itineraryIds) {
      assert.ok(
        candidateIds.has(placeId),
        `itinerary placeId ${placeId} missing from candidates`
      );
    }
  });
});

describe("prompt JSON validation", () => {
  for (const stage of PIPELINE_STAGES) {
    describe(`${stage}/v1.md`, () => {
      it("parses every JSON-like fence in the templated body", () => {
        const body = loadPrompt(stage, "v1").body;
        const failures = collectJsonFenceFailures(body);
        if (failures.length > 0) {
          assert.fail(
            `Found ${failures.length} invalid JSON block(s) in ${stage}/v1.md body:\n\n` +
              failures.join("\n\n")
          );
        }
      });
    });
  }
});
