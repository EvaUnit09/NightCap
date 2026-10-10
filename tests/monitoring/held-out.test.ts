import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redact } from "../../src/monitoring";
import { heldOutCases, heldOutMiss, heldOutSurvive } from "./fixtures/held-out-corpus";

describe("held-out corpus (frozen before generalization rewrite)", () => {
  for (const testCase of heldOutCases) {
    it(`${testCase.id} ${testCase.kind}: ${testCase.description}`, () => {
      const result = redact(testCase.input);
      assert.equal(result.text, testCase.expected, testCase.input);
    });
  }

  it("records coverage (do not add cases to chase this)", () => {
    assert.ok(heldOutMiss.length + heldOutSurvive.length >= 50);
  });
});
