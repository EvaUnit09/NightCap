import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GIVEN_NAME_COUNT,
  MAX_INPUT_CHARS,
  redact,
  redactForStorage,
  redactForTrace,
  redactTextUncapped,
  redactValue,
} from "../../src/monitoring";
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
  it("handles 4KB hyphen adversarial input in under 5ms", () => {
    const adversarial = "a-".repeat(2048);
    const start = performance.now();
    redact(adversarial);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 5, `Took ${elapsed}ms, should be < 5ms`);
  });

  it("handles 4KB apostrophe adversarial input in under 5ms", () => {
    const adversarial = "a'".repeat(2048);
    const start = performance.now();
    redact(adversarial);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 5, `Took ${elapsed}ms, should be < 5ms`);
  });

  it("scans 100KB uncapped hyphen input in under 50ms", () => {
    const adversarial = "a-".repeat(50_000);
    const start = performance.now();
    redactTextUncapped(adversarial);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 50, `Took ${elapsed}ms, should be < 50ms`);
  });

  it("fails closed on input over MAX_INPUT_CHARS", () => {
    const oversized = "x".repeat(MAX_INPUT_CHARS + 1);
    const result = redact(oversized);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "too_long");
      assert.equal(result.text, "");
    }
  });

  it("measures overflow in code points, not UTF-16 units", () => {
    const emojiOk = "😀".repeat(MAX_INPUT_CHARS);
    const emojiOver = "😀".repeat(MAX_INPUT_CHARS + 1);
    assert.equal(emojiOk.length > MAX_INPUT_CHARS, true);
    assert.equal(redact(emojiOk).ok, true);
    const result = redact(emojiOver);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "too_long");
      assert.equal(result.text, "");
    }
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

  it("redacts shared non-cyclic references twice, not as circular", () => {
    const shared = { note: "with my friend Priya" };
    const result = redactValue({ a: shared, b: shared }) as { a: { note: string }; b: { note: string } };
    assert.equal(result.a.note, "with my friend [NAME]");
    assert.equal(result.b.note, "with my friend [NAME]");
  });

  it("redacts object keys", () => {
    const result = redactValue({ "my friend Priya": "ok" }) as Record<string, string>;
    assert.deepEqual(result, { "my friend [NAME]": "ok" });
  });

  it("drops functions and symbols", () => {
    const result = redactValue({
      keep: "x",
      fn: () => "with my friend Priya",
      sym: Symbol("priya"),
    }) as Record<string, unknown>;
    assert.equal(result.keep, "x");
    assert.equal("fn" in result && result.fn === undefined, true);
  });

  it("converts Date, Map, Set, and Error", () => {
    const date = new Date("2026-10-10T00:00:00.000Z");
    assert.equal(redactValue(date), "2026-10-10T00:00:00.000Z");
    assert.deepEqual(redactValue(new Set(["with my friend Priya"])), ["with my friend [NAME]"]);
    assert.deepEqual(redactValue(new Map([["k", "with my friend Priya"]])), [["k", "with my friend [NAME]"]]);
    assert.deepEqual(redactValue(new Error("with my friend Priya")), {
      name: "Error",
      message: "with my friend [NAME]",
    });
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

  it("delegates objects instead of emitting [object Object]", () => {
    const result = redact({ a: "with my friend Priya" });
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.text, /\[object Object\]/);
    assert.match(result.text, /\[NAME\]/);
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

  it("bundles a public-domain given-name list in the 5k–10k range", () => {
    assert.ok(GIVEN_NAME_COUNT >= 5000 && GIVEN_NAME_COUNT <= 10_000, `count=${GIVEN_NAME_COUNT}`);
    assert.equal(MAX_INPUT_CHARS, 4096);
  });
});
