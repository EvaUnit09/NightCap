import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  EVAL_V1_CASE_COUNT,
  EVAL_V1_FILE,
  loadEvalCasesV1,
  parseEvalCases,
} from "../../evaluation/cases";

const EVAL_V1_SHA256 = "3dc5aad20bee1aab6e862d18a042c019680017becf6d0d85d71384b889cf2102";
const FROZEN_HINT =
  "evaluation/nightcap_eval_cases_v1.json is frozen. Do not edit it. " +
  "Record new failures in a v2 file (nightcap_eval_cases_v2.json) instead.";

const expectedIds = Array.from(
  { length: EVAL_V1_CASE_COUNT },
  (_, i) => `nc-${String(i + 1).padStart(3, "0")}`,
);

describe("eval set v1 is frozen", () => {
  it("keeps the file bytes identical", () => {
    const sha = createHash("sha256").update(readFileSync(EVAL_V1_FILE)).digest("hex");
    assert.equal(sha, EVAL_V1_SHA256, FROZEN_HINT);
  });

  it("has exactly 60 cases", () => {
    assert.equal(loadEvalCasesV1().length, EVAL_V1_CASE_COUNT, FROZEN_HINT);
  });

  it("has no duplicate ids", () => {
    const ids = loadEvalCasesV1().map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, FROZEN_HINT);
  });

  it("holds exactly nc-001 through nc-060, none missing or extra", () => {
    const ids = loadEvalCasesV1()
      .map((c) => c.id)
      .sort();
    assert.deepEqual(ids, expectedIds, FROZEN_HINT);
  });

  it("rejects a case outside the id pattern or with unknown fields", () => {
    const [first] = loadEvalCasesV1();
    assert.throws(() => parseEvalCases(JSON.stringify([{ ...first, id: "x-1" }])));
    assert.throws(() => parseEvalCases(JSON.stringify([{ ...first, extra: 1 }])));
  });
});

describe("eval set v1 coverage (step 18 Done when)", () => {
  const cases = loadEvalCasesV1();
  const has = (pred: (c: (typeof cases)[number]) => boolean) => cases.some(pred);

  it("covers all five boroughs", () => {
    const boroughs = new Set(cases.flatMap((c) => c.constraints.boroughs));
    for (const b of ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"]) {
      assert.ok(boroughs.has(b), b);
    }
  });

  it("covers budget caps from tight to 300", () => {
    assert.ok(has((c) => c.constraints.budget_max <= 60));
    assert.ok(has((c) => c.constraints.budget_max >= 250 && c.constraints.budget_max <= 300));
  });

  it("covers several time windows, vibes, and late Sunday", () => {
    assert.ok(new Set(cases.map((c) => c.constraints.time_window)).size >= 3);
    assert.ok(new Set(cases.flatMap((c) => c.constraints.vibes)).size >= 5);
    assert.ok(
      has(
        (c) =>
          c.constraints.day_of_week === "Sunday" && c.constraints.time_window.startsWith("late"),
      ),
    );
  });

  it("covers dietary and tight-budget edges", () => {
    assert.ok(has((c) => c.constraints.dietary.length > 0));
    assert.ok(has((c) => c.tags.includes("tight-budget")));
  });
});
