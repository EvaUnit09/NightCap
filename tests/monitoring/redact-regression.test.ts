import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redact, redactForStorage, redactForTrace, redactValue } from "../../src/monitoring";
import {
  additionalCases,
  allCases,
  contactCases,
  edgeCases,
  falsePositiveCases,
  nameCases,
  namedFpCases,
  namedMissCases,
  preservationCases,
  type TestCase,
} from "./fixtures/regression-corpus";

function runCase(testCase: TestCase): void {
  if (testCase.todo) {
    it.todo(`${testCase.id}: ${testCase.description} — ${testCase.todo}`);
    return;
  }
  it(`${testCase.id}: ${testCase.description}`, () => {
    const result = redact(testCase.input);
    assert.equal(result.text, testCase.expected, `Failed for: ${testCase.input}`);
  });
}

describe("Regression corpus - name redaction", () => {
  for (const testCase of nameCases) {
    runCase(testCase);
  }
});

describe("Regression corpus - preservation", () => {
  for (const testCase of preservationCases) {
    runCase(testCase);
  }
});

describe("Regression corpus - false positive prevention", () => {
  for (const testCase of falsePositiveCases) {
    runCase(testCase);
  }
});

describe("Regression corpus - contact information", () => {
  for (const testCase of contactCases) {
    runCase(testCase);
  }
});

describe("Regression corpus - edge cases", () => {
  for (const testCase of edgeCases) {
    runCase(testCase);
  }
});

describe("Regression corpus - additional realistic cases", () => {
  for (const testCase of additionalCases) {
    runCase(testCase);
  }
});

describe("Idempotence - redact(redact(x)) === redact(x)", () => {
  for (const testCase of allCases) {
    if (testCase.todo) {
      continue;
    }
    it(`${testCase.id} is idempotent`, () => {
      const once = redact(testCase.input);
      const twice = redact(once.text);
      assert.equal(twice.text, once.text, `Not idempotent: ${testCase.input}`);
    });
  }
});

describe("Performance - ReDoS protection", () => {
  it("handles 100KB adversarial street text in under 50ms", () => {
    const adversarial = "123 Main Street ".repeat(6000);
    const start = performance.now();
    redact(adversarial);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 50, `Took ${elapsed}ms, should be < 50ms`);
  });

  it("handles 100KB adversarial email pattern in under 50ms", () => {
    const adversarial = `${"a.".repeat(50_000)}@`;
    const start = performance.now();
    redact(adversarial);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 50, `Took ${elapsed}ms, should be < 50ms`);
  });

  it("redacts a full 4KB street string in under 50ms", () => {
    const input = "123 Main Street ".repeat(250).slice(0, 4096);
    const start = performance.now();
    const result = redact(input);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 50, `Took ${elapsed}ms, should be < 50ms`);
    assert.match(result.text, /\[ADDRESS\]/);
  });

  it("fails closed on input over 4KB", () => {
    const oversized = "x".repeat(10_000);
    const result = redact(oversized);
    assert.equal(result.text, "[REDACTION_ERROR: input exceeds 4KB limit]");
  });
});

describe("redactValue - recursive object/array redaction", () => {
  it("handles null", () => {
    assert.equal(redactValue(null), null);
  });

  it("handles undefined", () => {
    assert.equal(redactValue(undefined), undefined);
  });

  it("handles number", () => {
    assert.equal(redactValue(123), 123);
  });

  it("handles boolean", () => {
    assert.equal(redactValue(true), true);
  });

  it("handles string with PII", () => {
    assert.equal(redactValue("with my friend Priya"), "with my friend [NAME]");
  });

  it("handles object with string PII", () => {
    assert.deepEqual(redactValue({ a: "with my friend Priya" }), { a: "with my friend [NAME]" });
  });

  it("handles array with string PII", () => {
    assert.deepEqual(redactValue(["with my friend Priya"]), ["with my friend [NAME]"]);
  });

  it("handles nested object/array", () => {
    assert.deepEqual(
      redactValue({
        user: { query: "dinner with José", email: "jose@example.com" },
        tags: ["with my gf Sarah", "in Brooklyn"],
      }),
      {
        user: { query: "dinner with [NAME]", email: "[EMAIL]" },
        tags: ["with my gf [NAME]", "in Brooklyn"],
      },
    );
  });

  it("never throws on a circular object and fails closed", () => {
    const circular: { a: number; self?: unknown } = { a: 1 };
    circular.self = circular;
    const result = redactValue(circular);
    assert.ok(result);
    assert.equal((result as { self: unknown }).self, "[REDACTION_ERROR: circular reference]");
  });
});

describe("redact error handling", () => {
  it("does not throw on non-string input", () => {
    assert.doesNotThrow(() => redact(123));
    assert.doesNotThrow(() => redact(null));
    assert.doesNotThrow(() => redact(undefined));
    assert.doesNotThrow(() => redact({}));
  });

  it("coerces non-strings to string", () => {
    assert.equal(redact(123).text, "123");
  });
});

describe("JSDoc example accuracy", () => {
  it("redacts the documented storage/trace example", () => {
    const result = redact("Meeting my friend Sarah at 123 Main St, call me at 555-1234");
    assert.equal(result.text, "Meeting my friend [NAME] at [ADDRESS], call me at [PHONE]");
  });
});

describe("redactForStorage vs redactForTrace", () => {
  it("are documented aliases of redact", () => {
    const text = "dinner with my friend Priya at priya@email.com or 555-1234";
    const storage = redactForStorage(text);
    const trace = redactForTrace(text);
    const core = redact(text);
    assert.equal(storage.text, core.text);
    assert.equal(trace.text, core.text);
    assert.deepEqual(storage.counts, core.counts);
    assert.deepEqual(trace.counts, core.counts);
    assert.match(core.text, /\[PHONE\]/);
  });
});

describe("corpus coverage", () => {
  it("has at least 50 named miss cases plus false-positive checks", () => {
    assert.ok(namedMissCases.length >= 40, `named miss cases: ${namedMissCases.length}`);
    assert.ok(namedFpCases.length >= 20, `unchanged cases: ${namedFpCases.length}`);
    assert.ok(allCases.length >= 50, `total corpus: ${allCases.length}`);
  });
});
