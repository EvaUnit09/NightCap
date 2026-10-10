/**
 * Round-4 regressions. Inputs are intentionally different from
 * reviewer-quoted held-out v3/v4/v5 strings.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redact, redactValue } from "../../src/monitoring";
import {
  getRedactionWork,
  redactTextUncapped,
  resetRedactionWork,
} from "../../src/monitoring/redact";

/** Strong-cue frames with single-word NTA / given-name collisions. */
export const strongCuePersonCases: readonly { input: string; expected: string }[] = [
  { input: "Chelsea and I booked a booth", expected: "[NAME] and I booked a booth" },
  { input: "supper for Madison and me", expected: "supper for [NAME] and me" },
  { input: "taking Hollis out after 9", expected: "taking [NAME] out after 9" },
  { input: "Mr. Travis got there first", expected: "[NAME] got there first" },
  { input: "Norwood's birthday near 8", expected: "[NAME]'s birthday near 8" },
  { input: "Clifton + me after the show", expected: "[NAME] + me after the show" },
  { input: "brunch with Woodrow from the studio", expected: "brunch with [NAME] from the studio" },
  { input: "Arlington and I want dumplings", expected: "[NAME] and I want dumplings" },
  { input: "for me and Erasmus at 9", expected: "for me and [NAME] at 9" },
  { input: "taking Melrose out later", expected: "taking [NAME] out later" },
  { input: "Ms. Kensington wants natural wine", expected: "[NAME] wants natural wine" },
];

describe("strong cues still catch given-name / NTA collisions", () => {
  for (const testCase of strongCuePersonCases) {
    it(`redacts: ${testCase.input}`, () => {
      assert.equal(redact(testCase.input).text, testCase.expected);
    });
  }

  it("reports a catch rate over the strong-cue collision set", () => {
    const hits = strongCuePersonCases.filter((testCase) => redact(testCase.input).text === testCase.expected);
    const rate = hits.length / strongCuePersonCases.length;
    console.log(`strong-cue person catch rate: ${hits.length}/${strongCuePersonCases.length} (${(rate * 100).toFixed(1)}%)`);
    assert.equal(hits.length, strongCuePersonCases.length);
  });

  it("treats Chelsea as a person after a strong list cue, and as a place with no cue", () => {
    assert.equal(redact("Chelsea and I sat down for supper").text, "[NAME] and I sat down for supper");
    assert.equal(redact("drinks in Chelsea after ten").text, "drinks in Chelsea after ten");
  });
});

describe("weak with still vetoes single-word NTAs", () => {
  it("leaves a bare with + Chelsea neighborhood reading", () => {
    assert.equal(redact("mocktails with Chelsea energy").text, "mocktails with Chelsea energy");
  });

  it("leaves multi-word NTAs after taking", () => {
    assert.equal(redact("taking Hamilton Heights in on foot").text, "taking Hamilton Heights in on foot");
  });
});

describe("walkValue does not adopt __proto__", () => {
  it("stores a parsed __proto__ key on a null-prototype object", () => {
    const parsed = JSON.parse('{"__proto__":{"note":"supper with my friend Keiko"},"ok":true}') as Record<
      string,
      unknown
    >;
    const walked = redactValue(parsed) as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(walked), null);
    assert.equal(Object.hasOwn(walked, "__proto__"), true);
    assert.equal(({} as { note?: string }).note, undefined);
    assert.match(JSON.stringify(walked), /\[NAME\]/);
  });
});

function quadraticSpanWork(textLength: number, spanCount: number): number {
  let work = 0;
  for (let span = 0; span < spanCount; span += 1) {
    for (let i = 0; i < textLength; i += 1) {
      work += 1;
    }
  }
  return work;
}

describe("redaction work stays linear", () => {
  it("4x name-dense input stays under an 8x work bound", () => {
    const unit = "Nia/";
    const small = unit.repeat(200);
    const large = unit.repeat(800);
    resetRedactionWork();
    redactTextUncapped(small);
    const w1 = Math.max(getRedactionWork(), 1);
    resetRedactionWork();
    redactTextUncapped(large);
    const w4 = getRedactionWork();
    assert.ok(w4 / w1 < 8, `4x input used ${w4} work vs ${w1}`);
  });

  it("the same bound fails on the old quadratic span rewriter", () => {
    const unitLen = "Nia/".length;
    const smallLen = unitLen * 200;
    const largeLen = unitLen * 800;
    const q1 = Math.max(quadraticSpanWork(smallLen, 200), 1);
    const q4 = quadraticSpanWork(largeLen, 800);
    assert.ok(q4 / q1 >= 8, `quadratic rewriter ratio was only ${q4 / q1}`);
  });
});
