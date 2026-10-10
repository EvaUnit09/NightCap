import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redact } from "../../src/monitoring";
import { heldOutCases, heldOutMiss, heldOutSurvive } from "./fixtures/held-out-corpus";

const HELD_OUT_FLOOR = 0.8;

describe("held-out corpus (frozen before generalization rewrite)", () => {
  for (const testCase of heldOutCases) {
    it(`${testCase.id} ${testCase.kind}: ${testCase.description}`, () => {
      redact(testCase.input);
    });
  }

  it("meets an accuracy floor and lists misses (not 100%)", () => {
    const rows = heldOutCases.map((testCase) => {
      const actual = redact(testCase.input).text;
      return { ...testCase, actual, passed: actual === testCase.expected };
    });
    const misses = rows.filter((row) => !row.passed);
    const passRate = (rows.length - misses.length) / rows.length;
    console.log(
      `held-out pass rate: ${rows.length - misses.length}/${rows.length} (${(passRate * 100).toFixed(1)}%)`,
    );
    if (misses.length > 0) {
      console.log(
        "held-out misses:\n" +
          misses.map((row) => `  ${row.id} ${row.input} => ${row.actual}`).join("\n"),
      );
    }
    assert.ok(heldOutMiss.length + heldOutSurvive.length >= 50);
    assert.ok(
      passRate >= HELD_OUT_FLOOR,
      `held-out pass rate ${passRate} below floor ${HELD_OUT_FLOOR}; misses: ${misses.map((row) => row.id).join(", ")}`,
    );
  });
});
