import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redact } from "../../src/monitoring";
import { heldOutCases, heldOutMiss, heldOutSurvive } from "./fixtures/held-out-corpus";

describe("held-out corpus (frozen before generalization rewrite)", () => {
  const results = heldOutCases.map((testCase) => {
    const actual = redact(testCase.input).text;
    return { ...testCase, actual, passed: actual === testCase.expected };
  });

  it("records coverage and pass rate (do not add cases to chase this)", () => {
    const miss = results.filter((row) => row.kind === "miss");
    const survive = results.filter((row) => row.kind === "survive");
    const missPass = miss.filter((row) => row.passed).length;
    const survivePass = survive.filter((row) => row.passed).length;
    const totalPass = results.filter((row) => row.passed).length;
    // eslint-disable-next-line no-console
    console.log(
      `held-out pass rate: ${totalPass}/${results.length} overall, ` +
        `${missPass}/${miss.length} miss, ${survivePass}/${survive.length} survive`,
    );
    assert.ok(heldOutMiss.length + heldOutSurvive.length >= 50);
    for (const row of results) {
      assert.equal(row.actual, row.expected, `${row.id} ${row.input}`);
    }
  });
});
