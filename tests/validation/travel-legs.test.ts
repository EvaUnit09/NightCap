import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { resolve } from "node:path";

import { MAX_TRAVEL_LEGS_PER_REQUEST_DEFAULT as CONTRACT_MAX_LEGS } from "../../src/contracts/itinerary";
import {
  MAX_TRAVEL_LEGS_PER_REQUEST_DEFAULT,
  STOPS_MAX,
  STOPS_MIN,
} from "../../src/validation/bounds";
import { getMaxTravelLegsPerRequest, resetConfig } from "../../src/models/config";
import { clearPromptCache, loadPrompt } from "../../src/pipeline/prompt-loader";
import {
  allowedShapes,
  itinerarySchema,
  itinerarySchemaFor,
  parseItinerary,
  parseToolInput,
  type Stop,
} from "../../src/validation";

function stop(placeId: string, index: number, last: boolean): Stop {
  const hour = String(17 + index).padStart(2, "0");
  return {
    placeId,
    name: placeId,
    start: `2026-10-10T${hour}:00:00-04:00`,
    end: `2026-10-10T${hour}:40:00-04:00`,
    estimatedCostUsd: 40,
    why: "Quiet room and a short walk.",
    travelToNext: last ? null : { mode: "WALK", minutes: 10 },
  };
}

function itineraryFromCounts(counts: number[], singleStop = false) {
  let n = 0;
  return {
    singleStop,
    options: counts.map((count, optionIndex) => ({
      theme: `Option ${optionIndex + 1}`,
      stops: Array.from({ length: count }, (_, stopIndex) =>
        stop(`place-${n++}`, stopIndex, stopIndex === count - 1),
      ),
    })),
  };
}

describe("travel-leg cap", () => {
  it("exports MAX_TRAVEL_LEGS_PER_REQUEST_DEFAULT = 4 from bounds and contracts", () => {
    assert.equal(MAX_TRAVEL_LEGS_PER_REQUEST_DEFAULT, 4);
    assert.equal(CONTRACT_MAX_LEGS, MAX_TRAVEL_LEGS_PER_REQUEST_DEFAULT);
  });

  it("keeps validation/bounds free of config imports", () => {
    const source = readFileSync(resolve("src/validation/bounds.ts"), "utf8");
    assert.doesNotMatch(source, /models\/config|from ["'].*config["']/);
    const itinerary = readFileSync(resolve("src/validation/itinerary.ts"), "utf8");
    assert.doesNotMatch(itinerary, /models\/config|from ["'].*config["']/);
    const index = readFileSync(resolve("src/validation/index.ts"), "utf8");
    const toolInput = readFileSync(resolve("src/validation/tool-input.ts"), "utf8");
    assert.doesNotMatch(index, /models\/config|from ["'].*config["']/);
    assert.doesNotMatch(toolInput, /models\/config|from ["'].*config["']/);
  });

  it("accepts exactly the allowed multi-stop shapes and any single-stop shape", () => {
    const allowed = [
      [2, 2],
      [2, 3],
      [2, 4],
      [3, 3],
      [2, 2, 2],
      [2, 2, 3],
    ];
    for (const counts of allowed) {
      const parsed = itinerarySchema.safeParse(itineraryFromCounts(counts));
      assert.equal(parsed.success, true, `expected ${counts.join("+")} to pass`);
    }

    assert.equal(itinerarySchema.safeParse(itineraryFromCounts([1, 1], true)).success, true);
    assert.equal(itinerarySchema.safeParse(itineraryFromCounts([1, 1, 1], true)).success, true);
  });

  it("rejects 3+4, 4+4, 2+2+4, 2+3+3, and 3+3+3", () => {
    const rejected = [
      [3, 4],
      [4, 4],
      [2, 2, 4],
      [2, 3, 3],
      [3, 3, 3],
    ];
    for (const counts of rejected) {
      const parsed = itinerarySchema.safeParse(itineraryFromCounts(counts));
      assert.equal(parsed.success, false, `expected ${counts.join("+")} to fail`);
    }
  });

  it("keeps per-option stop ranges and lets itinerarySchemaFor take maxLegs from config", () => {
    assert.equal(STOPS_MIN, 2);
    assert.equal(STOPS_MAX, 4);
    assert.equal(itinerarySchema.safeParse(itineraryFromCounts([5, 2])).success, false);

    const tight = itinerarySchemaFor({ maxLegs: 3 });
    assert.equal(tight.safeParse(itineraryFromCounts([2, 3])).success, true);
    assert.equal(tight.safeParse(itineraryFromCounts([2, 4])).success, false);

    const loose = itinerarySchemaFor({ maxLegs: 6 });
    assert.equal(loose.safeParse(itineraryFromCounts([3, 4])).success, true);
  });

  it("lists default allowed shapes from allowedShapes(4)", () => {
    assert.deepEqual(allowedShapes(4), ["2+2", "2+3", "2+4", "3+3", "2+2+2", "2+2+3"]);
  });

  it("rejects maxLegs that are NaN, non-integer, or below 1", () => {
    for (const maxLegs of [Number.NaN, 1.5, 0, -1]) {
      assert.throws(
        () => itinerarySchemaFor({ maxLegs }),
        /maxLegs|integer|at least 1/i,
        `expected itinerarySchemaFor({ maxLegs: ${maxLegs} }) to throw`,
      );
    }
  });

  it("threads maxLegs through parseItinerary and parseToolInput, defaulting to 4", () => {
    const shape34 = itineraryFromCounts([3, 4]);
    assert.throws(() => parseItinerary(shape34));
    parseItinerary(shape34, 5);
    assert.throws(() =>
      parseToolInput({ tool: "validate_itinerary", itinerary: shape34 }),
    );
    parseToolInput({ tool: "validate_itinerary", itinerary: shape34 }, 5);
  });

  it("matches prompt shapes and parse acceptance when MAX_TRAVEL_LEGS_PER_REQUEST=5", () => {
    process.env.MAX_TRAVEL_LEGS_PER_REQUEST = "5";
    resetConfig();
    clearPromptCache();
    try {
      const maxLegs = getMaxTravelLegsPerRequest();
      assert.equal(maxLegs, 5);
      const shapes = allowedShapes(maxLegs);
      assert.ok(shapes.includes("3+4"));
      const listed = shapes.join(", ");
      for (const stage of ["plan_itineraries", "repair_itinerary", "refine_agent"] as const) {
        const body = loadPrompt(stage, "v1").body;
        assert.ok(body.includes(listed), `${stage} should list ${listed}`);
        assert.match(body, /3\+4/);
      }
      parseItinerary(itineraryFromCounts([3, 4]), maxLegs);
    } finally {
      delete process.env.MAX_TRAVEL_LEGS_PER_REQUEST;
      resetConfig();
      clearPromptCache();
    }
  });
});
