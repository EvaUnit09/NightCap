import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WRAP_USER_TEXT_MAX_CHARS } from "../../src/pipeline/wrap-user-text";
import {
  BUDGET_CUSTOM_MAX_USD,
  CHIP_TABLE,
  NO_OVERRIDES,
  REQUEST_TEXT_MAX_CHARS,
  TEXTAREA_MAX_CHARS,
  canSubmit,
  chipLabel,
  composeRequestText,
  parseCustomBudget,
  type Overrides,
  type WhenChoice,
} from "../../app/_home/request-text";

const MONDAY_NIGHT = new Date("2026-10-12T22:00:00-04:00");
const LONG_WEDNESDAY = new Date("2026-09-30T15:00:00-04:00");

describe("composeRequestText", () => {
  it("appends chip sentences after a blank line as absolute New York dates", () => {
    const text = composeRequestText(
      "Cocktails then ramen in the East Village",
      { ...NO_OVERRIDES, when: "this_friday", budget: { kind: "preset", usd: 250 }, travel: "TRANSIT" },
      MONDAY_NIGHT,
    );
    assert.equal(
      text,
      "Cocktails then ramen in the East Village\n\nOn Friday, October 16. Budget $250 total for the two of us. Getting around by subway.",
    );
  });

  it("sends trimmed text when nothing is overridden", () => {
    assert.equal(composeRequestText("  Just dinner  ", NO_OVERRIDES, MONDAY_NIGHT), "Just dinner");
  });

  it("uses tonight, tomorrow, and a near clause", () => {
    assert.equal(
      composeRequestText(
        "Dinner",
        { ...NO_OVERRIDES, when: "tonight", near: { lat: 40.7294, lng: -73.9846 } },
        MONDAY_NIGHT,
      ),
      "Dinner\n\nOn Monday, October 12. Near 40.729, -73.985.",
    );
    assert.equal(
      composeRequestText("Dinner", { ...NO_OVERRIDES, when: "tomorrow" }, MONDAY_NIGHT),
      "Dinner\n\nOn Tuesday, October 13.",
    );
  });

  it("keeps the client cap equal to the server cap", () => {
    assert.equal(REQUEST_TEXT_MAX_CHARS, WRAP_USER_TEXT_MAX_CHARS);
  });

  it("fits the longest textarea plus the longest suffix under the server cap", () => {
    const custom = parseCustomBudget(String(BUDGET_CUSTOM_MAX_USD));
    assert.ok(custom);
    const max: Overrides = {
      when: "tonight",
      budget: { kind: "custom", usd: custom },
      travel: "WALK",
      near: { lat: -90, lng: -180 },
    };
    const text = "x".repeat(TEXTAREA_MAX_CHARS);
    const composed = composeRequestText(text, max, LONG_WEDNESDAY);
    assert.equal(composed.length, REQUEST_TEXT_MAX_CHARS);
    assert.match(
      composed,
      /On Wednesday, September 30\. Budget \$100000 total for the two of us\. Getting around by walking\. Near -90\.000, -180\.000\.$/,
    );

    const whenChoices: readonly (WhenChoice | null)[] = [null, ...CHIP_TABLE.when.options.map((option) => option.value)];
    const budgets: Overrides["budget"][] = [
      null,
      ...CHIP_TABLE.budget.options.map((option) => ({ kind: "preset" as const, usd: option.value })),
      { kind: "custom", usd: custom },
    ];
    const travels: Overrides["travel"][] = [null, ...CHIP_TABLE.travel.options.map((option) => option.value)];
    const nears: Overrides["near"][] = [null, { lat: -90, lng: -180 }];
    for (const when of whenChoices) {
      for (const budget of budgets) {
        for (const travel of travels) {
          for (const near of nears) {
            const sample = composeRequestText(text, { when, budget, travel, near }, LONG_WEDNESDAY);
            assert.ok(sample.length <= REQUEST_TEXT_MAX_CHARS);
          }
        }
      }
    }
  });
});

describe("chips", () => {
  it("enables submit only for non-blank text", () => {
    assert.equal(canSubmit(""), false);
    assert.equal(canSubmit("   "), false);
    assert.equal(canSubmit("Dinner"), true);
  });

  it("parses a whole-dollar custom budget", () => {
    assert.equal(parseCustomBudget("$1,500"), 1500);
    assert.equal(parseCustomBudget("0"), null);
    assert.equal(parseCustomBudget("100001"), null);
    assert.equal(parseCustomBudget("12.5"), null);
    assert.equal(parseCustomBudget(""), null);
  });

  it("reads labels from CHIP_TABLE", () => {
    assert.equal(chipLabel("travel", NO_OVERRIDES), "Walking");
    assert.equal(chipLabel("travel", { ...NO_OVERRIDES, travel: "TRANSIT" }), "Subway");
    assert.equal(chipLabel("when", { ...NO_OVERRIDES, when: "this_friday" }), "This Friday");
    assert.equal(chipLabel("budget", { ...NO_OVERRIDES, budget: { kind: "preset", usd: 75 } }), "$75 for two");
    const custom = parseCustomBudget("400");
    assert.ok(custom);
    assert.equal(chipLabel("budget", { ...NO_OVERRIDES, budget: { kind: "custom", usd: custom } }), "$400 for two");
  });
});
