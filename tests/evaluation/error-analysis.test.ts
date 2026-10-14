import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { EVAL_V2_FILE, loadEvalCasesV1, loadEvalCasesV2 } from "../../evaluation/cases";
import {
  ERROR_TAXONOMY,
  WEEKLY_PULL,
  labelForPipelineFailure,
  labelForValidatorCode,
  weeklyPullText,
} from "../../evaluation/error-analysis";
import { validationErrorCodeSchema } from "../../src/validation/validation-error";

const DOC = join(import.meta.dirname, "../../docs/error-analysis.md");

const TAXONOMY = [
  "closed venue",
  "over budget",
  "travel too far",
  "wrong vibe",
  "generic/repeat venue",
  "parse miss",
  "agent overreach",
  "other",
] as const;

describe("weekly error analysis", () => {
  it("keeps the procedure doc and the eight taxonomy labels", () => {
    const doc = readFileSync(DOC, "utf8");
    assert.equal(ERROR_TAXONOMY.length, 8);
    assert.deepEqual(ERROR_TAXONOMY, TAXONOMY);
    for (const label of TAXONOMY) {
      assert.equal(doc.includes(label), true, label);
    }
    assert.equal(doc.includes("feedback.request_hash"), true);
    assert.equal(doc.includes("@request_hash:"), true);
    assert.equal(doc.includes("add to v2"), true);
    assert.equal(doc.includes("### Date"), true);
    assert.equal(doc.includes("### Counts"), true);
    assert.equal(doc.includes("### Fix"), true);
    assert.equal(doc.includes("### Before/after"), true);
    assert.equal(doc.includes(WEEKLY_PULL.repairSpans), true);
    assert.equal(doc.includes(WEEKLY_PULL.invalidSpans), true);
    assert.equal(doc.includes(WEEKLY_PULL.failedPlans), true);
    assert.equal(doc.includes(WEEKLY_PULL.thumbsDownSql), true);
    assert.equal(doc.includes(WEEKLY_PULL.closedReportSql), true);
  });

  it("maps each validator code to a taxonomy label", () => {
    const expected = {
      not_found: "other",
      not_operational: "closed venue",
      closed: "closed venue",
      over_budget: "over budget",
      travel_too_long: "travel too far",
      invented_venue: "other",
      invalid_format: "parse miss",
      name_mismatch: "parse miss",
      implausible_cost: "over budget",
      travel_unverified: "travel too far",
      travel_mismatch: "travel too far",
      travel_service_unavailable: "other",
    } as const;
    assert.deepEqual(validationErrorCodeSchema.options, Object.keys(expected));
    for (const code of validationErrorCodeSchema.options) {
      assert.equal(labelForValidatorCode(code), expected[code], code);
    }
    assert.equal(labelForValidatorCode("invented_venue", "agent"), "agent overreach");
    assert.equal(labelForValidatorCode("invented_venue", "repair"), "other");
    assert.equal(labelForPipelineFailure({ stage: "parse", code: "no_json" }), "parse miss");
    assert.equal(labelForPipelineFailure({ stage: "plan", code: "schema_invalid" }), "parse miss");
    assert.equal(labelForPipelineFailure({ stage: "plan", code: "model_error" }), "other");
    assert.equal(labelForPipelineFailure({ stage: "validate", code: "no_valid_options" }), "other");
    assert.equal(labelForPipelineFailure({ stage: "retrieve", code: "no_candidates" }), "other");
    assert.equal(labelForPipelineFailure({ stage: "redact", code: "empty" }), "other");
  });

  it("prints the Datadog and Supabase queries", () => {
    const repo = join(import.meta.dirname, "../..");
    const result = spawnSync("node", ["--import", "tsx", "evaluation/error-analysis.ts"], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${weeklyPullText()}\n`);
    assert.equal(result.stdout.includes("@ml_app:nightcap @stage:repair"), true);
    assert.equal(result.stdout.includes("thumbs = -1"), true);
    assert.equal(result.stdout.includes("feedback.request_hash"), true);
  });

  it("parses v2 as an array and keeps its ids out of frozen v1", () => {
    const parsed: unknown = JSON.parse(readFileSync(EVAL_V2_FILE, "utf8"));
    if (!Array.isArray(parsed)) {
      assert.fail("evaluation/nightcap_eval_cases_v2.json is not an array");
    }
    const v2 = loadEvalCasesV2();
    assert.equal(v2.length, parsed.length);
    const v1 = new Set(loadEvalCasesV1().map((evalCase) => evalCase.id));
    assert.deepEqual(
      v2.map((evalCase) => evalCase.id).filter((id) => v1.has(id)),
      [],
    );
  });
});
