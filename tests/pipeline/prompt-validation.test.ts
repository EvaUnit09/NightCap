import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PIPELINE_STAGES, loadPrompt } from "../../src/pipeline/prompt-loader";
import {
  BYPASS_FENCE_VARIANTS,
  TAXI_ITINERARY,
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

  it("recognizes ~~~ fences", () => {
    const blocks = extractFencedBlocks(
      bypassDocument("~~~json schema=itinerary", "~~~")
    );
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].language, "json");
    assert.equal(blocks[0].schemaName, "itinerary");
    const failures = collectJsonFenceFailures(
      bypassDocument("~~~json schema=itinerary", "~~~")
    );
    assert.ok(failures.some((failure) => /invalid|travel|mode/i.test(failure)));
  });

  it("recognizes a space before the info string", () => {
    const blocks = extractFencedBlocks(
      bypassDocument("``` json schema=itinerary", "```")
    );
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].language, "json");
    assert.equal(blocks[0].schemaName, "itinerary");
    const failures = collectJsonFenceFailures(
      bypassDocument("``` json schema=itinerary", "```")
    );
    assert.ok(failures.some((failure) => /invalid|travel|mode/i.test(failure)));
  });

  it("fails on an unclosed fence", () => {
    const failures = collectJsonFenceFailures(
      "```json schema=itinerary\n" + TAXI_ITINERARY + "\n"
    );
    assert.ok(failures.some((failure) => /unclosed/i.test(failure)));
  });

  it("treats bare, js, and javascript fences that parse as JSON as JSON", () => {
    for (const open of ["```", "```js", "```javascript"]) {
      const failures = collectJsonFenceFailures(`${open}\n${TAXI_ITINERARY}\n\`\`\`\n`);
      assert.ok(
        failures.some((failure) => /missing schema annotation|invalid|travel|mode/i.test(failure)),
        `${open}: ${failures.join("; ")}`
      );
      assert.equal(
        failures.includes("Expected at least one schema-validated JSON example."),
        false,
        `${open} must not be skipped as non-JSON`
      );
    }
  });
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

  it("validates all 18 prompt JSON examples as written", () => {
    let count = 0;
    for (const stage of PIPELINE_STAGES) {
      const body = loadPrompt(stage, "v1").body;
      assert.deepEqual(collectJsonFenceFailures(body), []);
      for (const block of extractFencedBlocks(body)) {
        try {
          JSON.parse(block.blockText);
        } catch {
          continue;
        }
        if (block.schemaName && block.schemaName !== "none") {
          count += 1;
        }
      }
    }
    assert.equal(count, 18);
  });
});

describe("repair_itinerary error codes", () => {
  const NEW_CODES = [
    "invalid_format",
    "name_mismatch",
    "implausible_cost",
    "travel_unverified",
    "travel_mismatch",
  ] as const;

  it("lists #7 validation codes with one-line repair guidance and no premature JSON examples", () => {
    const repair = loadPrompt("repair_itinerary", "v1").body;
    for (const code of NEW_CODES) {
      const fence = new RegExp(`\`\`\`json[^\n]*schema=validationError[\\s\\S]*?"code":\\s*"${code}"`);
      assert.doesNotMatch(repair, fence, `${code} must not appear in a validationError JSON block yet`);
      const listed = new RegExp(`\`${code}\`[^\\n]+`);
      const line = repair.match(listed)?.[0];
      assert.ok(line, `expected a \`${code}\` list line with guidance`);
      assert.ok(line.length > code.length + 8, `expected one-line repair guidance for ${code}`);
    }
  });
});

describe("single-stop prompt rules", () => {
  it("lets repair emit a 1-stop option when singleStop is true", () => {
    const repair = loadPrompt("repair_itinerary", "v1").body;
    assert.match(repair, /singleStop/);
    assert.match(repair, /exactly 1|1 stop/);
    assert.doesNotMatch(
      repair,
      /Keep 2–4 stops in chronological order\.(?!\s*(?:When|If|unless|or exactly))/
    );
  });

  it("tells plan, repair, and refine never to set singleStop themselves", () => {
    const plan = loadPrompt("plan_itineraries", "v1").body;
    const repair = loadPrompt("repair_itinerary", "v1").body;
    const refine = loadPrompt("refine_agent", "v1").body;
    assert.match(plan, /never.{0,40}set.{0,20}singleStop/i);
    assert.match(repair, /never.{0,40}set.{0,20}singleStop/i);
    assert.match(refine, /never.{0,40}set.{0,20}singleStop/i);
  });

  it("omits singleStop from plan itinerary JSON examples", () => {
    const plan = loadPrompt("plan_itineraries", "v1").body;
    const blocks = extractFencedBlocks(plan);
    const itineraries = blocks.filter((block) => block.schemaName === "itinerary");
    assert.ok(itineraries.length >= 2, "expected default and single-stop plan examples");
    for (const block of itineraries) {
      const parsed = JSON.parse(block.blockText) as { singleStop?: unknown };
      assert.equal(Object.hasOwn(parsed, "singleStop"), false);
    }
  });

  it("explains that ‹ › inside user_text are escaped < and >", () => {
    for (const stage of PIPELINE_STAGES) {
      const body = loadPrompt(stage, "v1").body;
      assert.match(body, /‹/, `${stage} should mention ‹`);
      assert.match(body, /›/, `${stage} should mention ›`);
      assert.match(body, /escap/i, `${stage} should say ‹ › are escaped brackets`);
    }
  });

  it("requires exactly one stop when singleStop is true, not a 1–4 range", () => {
    const plan = loadPrompt("plan_itineraries", "v1").body;
    assert.doesNotMatch(plan, /singleStop[\s\S]{0,80}1–4/);
    assert.match(plan, /singleStop[\s\S]{0,220}exactly 1/);
  });

  it("treats bare 'just dinner' and 'one place' as single-stop triggers", () => {
    const parse = loadPrompt("parse_intent", "v1").body;
    assert.match(parse, /"just dinner"/);
    assert.match(parse, /"one place"/);
    assert.match(parse, /prompt-only/);
  });

  it("keeps the explicit single-stop parse example on a 4-hour window", () => {
    const parse = loadPrompt("parse_intent", "v1").body;
    const blocks = extractFencedBlocks(parse);
    const single = blocks
      .map((block) => JSON.parse(block.blockText) as { singleStop?: boolean; window?: { start: string; end: string } })
      .find((parsed) => parsed.singleStop === true);
    assert.ok(single?.window, "expected a singleStop intent example");
    const hours =
      (Date.parse(single.window.end) - Date.parse(single.window.start)) / 3_600_000;
    assert.equal(hours, 4);
  });

  it("explains the user_text markers in every prompt", () => {
    for (const stage of PIPELINE_STAGES) {
      const body = loadPrompt(stage, "v1").body;
      assert.match(
        body,
        /<user_text>[\s\S]{0,200}untrusted|delimit|ignore any instructions inside/i,
        `${stage} should explain the user_text markers`
      );
    }
  });

  it("does not rewrite travel modes before schema checks", () => {
    const source = readFileSync(resolve("tests/pipeline/prompt-json-blocks.ts"), "utf8");
    assert.doesNotMatch(source, /LEGACY_MODE_FOR_CONTRACT|rewriteContractTravelModes/);
  });

  it("templates the travel-leg cap and spells out the allowed shapes", () => {
    const plan = loadPrompt("plan_itineraries", "v1").body;
    const repair = loadPrompt("repair_itinerary", "v1").body;
    const refine = loadPrompt("refine_agent", "v1").body;
    for (const [name, body] of [
      ["plan", plan],
      ["repair", repair],
      ["refine", refine],
    ] as const) {
      assert.match(body, /4/, `${name} should include the templated leg cap`);
      assert.match(body, /2\+2/);
      assert.match(body, /2\+3/);
      assert.match(body, /2\+4/);
      assert.match(body, /3\+3/);
      assert.match(body, /2\+2\+2/);
      assert.match(body, /2\+2\+3/);
    }
    assert.match(plan, /prefer[\s\S]{0,80}2 options of 3|3 options of 2/i);
  });

  it("tells plan when to pick BICYCLE and to stay conservative at night", () => {
    const plan = loadPrompt("plan_itineraries", "v1").body;
    assert.match(plan, /BICYCLE/);
    assert.match(plan, /bik/i);
    assert.match(plan, /short/i);
    assert.match(plan, /night/i);
  });

  it("guides repair on unsupported modes, stop minimum, and singleStop re-stamp", () => {
    const repair = loadPrompt("repair_itinerary", "v1").body;
    assert.match(repair, /travel_unverified[\s\S]{0,200}allowed mode|unsupported mode/i);
    assert.doesNotMatch(repair, /drop the hop/i);
    assert.match(repair, /invalid_format[\s\S]{0,240}re-stamp|stamps/i);
  });

  it("says budgetUsd and estimatedCostUsd are party totals, not per person", () => {
    for (const stage of PIPELINE_STAGES) {
      const body = loadPrompt(stage, "v1").body;
      assert.doesNotMatch(
        body,
        /estimatedCostUsd[\s\S]{0,80}per-person|per-person amount/,
        `${stage} must not call estimatedCostUsd per-person`,
      );
    }
    const parse = loadPrompt("parse_intent", "v1").body;
    const plan = loadPrompt("plan_itineraries", "v1").body;
    assert.match(parse, /party|couple/i);
    assert.match(plan, /party|couple|whole party/i);
  });

  it("lists only TRANSIT, BICYCLE, and WALK as travel modes", () => {
    for (const stage of PIPELINE_STAGES) {
      const body = loadPrompt(stage, "v1").body;
      assert.match(body, /TRANSIT/);
      assert.match(body, /BICYCLE/);
      assert.match(body, /WALK/);
      assert.doesNotMatch(body, /"mode": "(walk|transit|rideshare|taxi|DRIVE)"/);
    }
    const scope = readFileSync(resolve("docs/scope.md"), "utf8");
    const architecture = readFileSync(resolve("docs/architecture.md"), "utf8");
    assert.match(scope, /TRANSIT/);
    assert.match(scope, /BICYCLE/);
    assert.match(scope, /WALK/);
    assert.match(architecture, /TRANSIT, BICYCLE, and WALK/);
  });

  it("mentions the single-stop exception in refine_agent, scope, and architecture", () => {
    const refine = loadPrompt("refine_agent", "v1").body;
    assert.match(refine, /singleStop|exactly \{\{min_stops_single\}\}/);
    const scope = readFileSync(resolve("docs/scope.md"), "utf8");
    const architecture = readFileSync(resolve("docs/architecture.md"), "utf8");
    assert.match(scope, /single (place|stop)/i);
    assert.match(architecture, /singleStop|single (place|stop)/i);
  });
});

describe("loadPrompt JSDoc", () => {
  it("documents loadPrompt params and marks promptsRoot as test-only", () => {
    const source = readFileSync(resolve("src/pipeline/prompt-loader.ts"), "utf8");
    assert.match(source, /@param stage/);
    assert.match(source, /@param version/);
    assert.match(source, /test-only/i);
    assert.match(source, /promptsRoot/);
    assert.match(source, /path traversal/i);
    assert.match(source, /front matter/i);
    assert.match(source, /SHA-256|content-based versioning|CRLF/i);
  });
});
