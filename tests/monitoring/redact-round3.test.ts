/**
 * Round-3 regressions. Inputs are intentionally different from the
 * reviewer-quoted examples so the fixes have to be general.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isGivenName } from "../../src/monitoring/data/lookup";
import { GIVEN_NAME_COUNT, MAX_INPUT_CHARS, redact, redactValue } from "../../src/monitoring";
import { redactTextUncapped } from "../../src/monitoring/redact";

function medianMs(fn: () => void, warm = 3, runs = 7): number {
  for (let i = 0; i < warm; i += 1) {
    fn();
  }
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

describe("strong cues must not wipe calendar or borough terms", () => {
  it("leaves a weekday after a bare date-noun", () => {
    assert.equal(redact("brunch reservation Wednesday in Tribeca").text, "brunch reservation Wednesday in Tribeca");
  });

  it("leaves a month used as a calendar date", () => {
    assert.equal(redact("reservation April 3 around 8").text, "reservation April 3 around 8");
  });

  it("leaves a labeled weekday and month abbreviation", () => {
    assert.equal(redact("Night out: Saturday, Nov 8").text, "Night out: Saturday, Nov 8");
  });

  it("leaves a borough after an action verb", () => {
    assert.equal(redact("Taking Brooklyn by storm").text, "Taking Brooklyn by storm");
  });

  it("still redacts a month after possessive + relation", () => {
    assert.equal(redact("dinner with my girlfriend April").text, "dinner with my girlfriend [NAME]");
  });

  it("still redacts after an article + relation with a whitespace gap", () => {
    assert.equal(redact("a roommate Dorota").text, "a roommate [NAME]");
  });
});

describe("possessive event cue is an allowlist", () => {
  it("leaves a possessive venue + food noun", () => {
    assert.equal(redact("Lombardi's slices after the show").text, "Lombardi's slices after the show");
  });

  it("leaves another possessive venue + common noun", () => {
    assert.equal(redact("Di Fara's oven if we can walk").text, "Di Fara's oven if we can walk");
  });

  it("never fires before day", () => {
    assert.equal(redact("Father's day brunch").text, "Father's day brunch");
    assert.equal(redact("New Year's day walk").text, "New Year's day walk");
  });

  it("redacts possessive + allowlisted event noun", () => {
    assert.equal(redact("plan for Nia's bday").text, "plan for [NAME]'s bday");
    assert.equal(redact("Keiko's anniversary dinner").text, "[NAME]'s anniversary dinner");
  });

  it("skips a two-token capitalized venue possessive", () => {
    assert.equal(redact("walk past L'Artusi's pasta").text, "walk past L'Artusi's pasta");
  });
});

describe("added relation words and first-person list cues", () => {
  it("redacts after newer kinship slang", () => {
    assert.equal(redact("my bestie Nia wants wine").text, "my bestie [NAME] wants wine");
    assert.equal(redact("my bff Keiko").text, "my bff [NAME]");
    assert.equal(redact("my hubby Tarek and I").text, "my hubby [NAME] and I");
    assert.equal(redact("my grandma Aoife").text, "my grandma [NAME]");
    assert.equal(redact("my crush Chioma").text, "my crush [NAME]");
  });

  it("redacts X & I and X + me and myself and X", () => {
    assert.equal(redact("Nia & I want ramen").text, "[NAME] & I want ramen");
    assert.equal(redact("Keiko + me need sushi").text, "[NAME] + me need sushi");
    assert.equal(redact("myself and Tarek").text, "myself and [NAME]");
  });

  it("catches a third list member after & and a second after /", () => {
    assert.equal(redact("Nia, Keiko & Tarek").text, "[NAME], [NAME] & [NAME]");
    assert.equal(redact("Nia/Keiko/Tarek").text, "[NAME]/[NAME]/[NAME]");
  });
});

describe("public API and linear span handling", () => {
  it("keeps redactForStorage and does not export redactForTrace from the barrel", async () => {
    const monitoring = await import("../../src/monitoring");
    assert.equal(typeof monitoring.redactForStorage, "function");
    assert.equal("redactForTrace" in monitoring, false);
    assert.equal("redactTextUncapped" in monitoring, false);
  });

  it("grows roughly linearly on name-dense input", () => {
    const unit = "Nia/";
    const small = unit.repeat(200);
    const large = unit.repeat(800);
    const t1 = medianMs(() => {
      redactTextUncapped(small);
    });
    const t4 = medianMs(() => {
      redactTextUncapped(large);
    });
    assert.ok(t4 / Math.max(t1, 0.05) < 8, `4x input took ${t4}ms vs ${t1}ms`);
  });

  it("also stays linear on for-me-and and title-dense text", () => {
    const andChunk = "for me and Nia and ";
    const titleChunk = "Mr. Nia ";
    const tAnd = medianMs(() => {
      redactTextUncapped(andChunk.repeat(300));
    });
    const tTitle = medianMs(() => {
      redactTextUncapped(titleChunk.repeat(300));
    });
    assert.ok(tAnd < 40, `for-me-and dense took ${tAnd}ms`);
    assert.ok(tTitle < 40, `title-dense took ${tTitle}ms`);
  });
});

describe("redactValue hardening", () => {
  it("maps binary-like values to [BINARY]", () => {
    assert.equal(redactValue(Buffer.from("secret")), "[BINARY]");
    assert.equal(redactValue(new Uint8Array([1, 2, 3])), "[BINARY]");
    assert.equal(redactValue(new ArrayBuffer(8)), "[BINARY]");
    assert.equal(redactValue(new DataView(new ArrayBuffer(4))), "[BINARY]");
  });

  it("fails closed on an invalid Date", () => {
    const result = redactValue(new Date("not-a-date"));
    assert.equal(result, "[REDACTION_ERROR]");
  });

  it("disambiguates colliding redacted keys", () => {
    const result = redactValue({
      "my friend Nia": "a",
      "my friend Keiko": "b",
    }) as Record<string, string>;
    const keys = Object.keys(result);
    assert.equal(keys.length, 2);
    assert.ok(keys.every((key) => key.includes("[NAME]")));
    assert.notEqual(keys[0], keys[1]);
  });

  it("propagates overflow from a nested string on redact(object)", () => {
    const result = redact({ note: "x".repeat(MAX_INPUT_CHARS + 1) });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "too_long");
      assert.equal(result.text, "");
    }
  });

  it("fails closed after a node budget", () => {
    const fat = Array.from({ length: 12_000 }, (_, i) => i);
    const result = redactValue(fat);
    assert.ok(result === "[REDACTION_ERROR]" || (Array.isArray(result) && result.includes("[REDACTION_ERROR]")));
  });
});

describe("given-name list coverage", () => {
  it("includes later-year and international names used in this round", () => {
    assert.equal(isGivenName("Kaveh"), true);
    assert.equal(isGivenName("Uchenna"), true);
    assert.equal(isGivenName("Dorota"), true);
    assert.equal(isGivenName("Saoirse"), true);
    assert.equal(isGivenName("Chioma"), true);
    assert.equal(isGivenName("Tarek"), true);
    assert.ok(GIVEN_NAME_COUNT >= 5000);
  });
});
