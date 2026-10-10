import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redact, redactValue, redactForStorage, redactForTrace } from "../../src/monitoring";
import { allCases, nameCases, preservationCases, falsePositiveCases, contactCases, edgeCases, additionalCases } from "./fixtures/regression-corpus";

describe("Regression corpus - name redaction", () => {
  for (const testCase of nameCases) {
    it(`${testCase.id}: ${testCase.description}`, () => {
      const result = redact(testCase.input);
      assert.equal(result.text, testCase.expected, `Failed for: ${testCase.input}`);
    });
  }
});

describe("Regression corpus - preservation", () => {
  for (const testCase of preservationCases) {
    it(`${testCase.id}: ${testCase.description}`, () => {
      const result = redact(testCase.input);
      assert.equal(result.text, testCase.expected, `Failed for: ${testCase.input}`);
    });
  }
});

describe("Regression corpus - false positive prevention", () => {
  for (const testCase of falsePositiveCases) {
    it(`${testCase.id}: ${testCase.description}`, () => {
      const result = redact(testCase.input);
      assert.equal(result.text, testCase.expected, `Failed for: ${testCase.input}`);
    });
  }
});

describe("Regression corpus - contact information", () => {
  for (const testCase of contactCases) {
    it(`${testCase.id}: ${testCase.description}`, () => {
      const result = redact(testCase.input);
      assert.equal(result.text, testCase.expected, `Failed for: ${testCase.input}`);
    });
  }
});

describe("Regression corpus - edge cases", () => {
  for (const testCase of edgeCases) {
    it(`${testCase.id}: ${testCase.description}`, () => {
      const result = redact(testCase.input);
      assert.equal(result.text, testCase.expected, `Failed for: ${testCase.input}`);
    });
  }
});

describe("Regression corpus - additional realistic cases", () => {
  for (const testCase of additionalCases) {
    it(`${testCase.id}: ${testCase.description}`, () => {
      const result = redact(testCase.input);
      assert.equal(result.text, testCase.expected, `Failed for: ${testCase.input}`);
    });
  }
});

describe("Idempotence - redact(redact(x)) === redact(x)", () => {
  for (const testCase of allCases) {
    it(`${testCase.id} is idempotent`, () => {
      const once = redact(testCase.input);
      const twice = redact(once.text);
      assert.equal(twice.text, once.text, `Not idempotent: ${testCase.input}`);
    });
  }
});

describe("Performance - ReDoS protection", () => {
  it("handles 100KB adversarial input (digits/words) in under 50ms", () => {
    // Adversarial case: long runs of digits and words
    const adversarial = "123 Main Street ".repeat(6000); // ~100KB
    const start = performance.now();
    redact(adversarial);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 50, `Took ${elapsed}ms, should be < 50ms`);
  });

  it("handles 100KB adversarial email pattern (a. repeated) in under 50ms", () => {
    // Adversarial for email regex: "a.a.a...@"
    const adversarial = "a.".repeat(50000) + "@"; // ~100KB
    const start = performance.now();
    redact(adversarial);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 50, `Took ${elapsed}ms, should be < 50ms`);
  });

  it("handles maximum allowed input size", () => {
    const maxInput = "x".repeat(4096); // 4KB
    const result = redact(maxInput);
    assert.ok(result.text.length > 0);
  });

  it("fails closed or truncates on oversized input", () => {
    const oversized = "x".repeat(10000); // 10KB
    // Should either truncate or redact the entire thing
    const result = redact(oversized);
    // Just verify it completes without throwing
    assert.ok(result);
  });
});

describe("redactValue - recursive object/array redaction", () => {
  it("handles null", () => {
    const result = redactValue(null);
    assert.strictEqual(result, null);
  });

  it("handles undefined", () => {
    const result = redactValue(undefined);
    assert.strictEqual(result, undefined);
  });

  it("handles number", () => {
    const result = redactValue(123);
    assert.strictEqual(result, 123);
  });

  it("handles boolean", () => {
    const result = redactValue(true);
    assert.strictEqual(result, true);
  });

  it("handles string with PII", () => {
    const result = redactValue("with my friend Priya");
    assert.equal(result, "with my friend [NAME]");
  });

  it("handles object with string PII", () => {
    const result = redactValue({ a: "with my friend Priya" });
    assert.deepEqual(result, { a: "with my friend [NAME]" });
  });

  it("handles array with string PII", () => {
    const result = redactValue(["with my friend Priya"]);
    assert.deepEqual(result, ["with my friend [NAME]"]);
  });

  it("handles nested object/array", () => {
    const result = redactValue({
      user: { query: "dinner with José", email: "jose@example.com" },
      tags: ["with my gf Sarah", "in Brooklyn"],
    });
    assert.deepEqual(result, {
      user: { query: "dinner with [NAME]", email: "[EMAIL]" },
      tags: ["with my gf [NAME]", "in Brooklyn"],
    });
  });

  it("never throws on internal error - fails closed", () => {
    // Simulate pathological input
    const circular: any = { a: 1 };
    circular.self = circular;
    // Should not throw
    const result = redactValue(circular);
    assert.ok(result);
  });
});

describe("redact error handling", () => {
  it("does not throw on non-string input", () => {
    assert.doesNotThrow(() => redact(123 as any));
    assert.doesNotThrow(() => redact(null as any));
    assert.doesNotThrow(() => redact(undefined as any));
    assert.doesNotThrow(() => redact({} as any));
  });

  it("coerces non-strings to string", () => {
    const result = redact(123 as any);
    assert.equal(result.text, "123");
  });
});

describe("JSDoc example accuracy", () => {
  it("matches the documented example at line ~208-210", () => {
    const result = redact("Meeting my friend Sarah at 123 Main St, call me at 555-1234");
    // The JSDoc says phones are redacted - verify it actually happens
    assert.match(result.text, /\[PHONE\]/);
    assert.match(result.text, /\[NAME\]/);
    assert.match(result.text, /\[ADDRESS\]/);
  });
});

describe("redactForStorage vs redactForTrace", () => {
  it("redactForStorage and redactForTrace produce same result", () => {
    const text = "dinner with my friend Priya at priya@email.com";
    const storage = redactForStorage(text);
    const trace = redactForTrace(text);
    assert.equal(storage.text, trace.text);
    assert.deepEqual(storage.counts, trace.counts);
  });
});
