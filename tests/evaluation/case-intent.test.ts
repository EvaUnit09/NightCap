import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { intentFromCase } from "../../evaluation/case-intent";
import { loadEvalCasesV1 } from "../../evaluation/cases";
import { partyBudgetFor } from "../../evaluation/party-budget";

const CASES = loadEvalCasesV1();

function caseById(id: string) {
  const found = CASES.find((entry) => entry.id === id);
  assert.ok(found, id);
  return found;
}

describe("intentFromCase", () => {
  it("maps every frozen v1 case to a schema-valid intent in the fixed EDT week", () => {
    for (const entry of CASES) {
      const intent = intentFromCase(entry);
      assert.ok(intent.window.start.endsWith("-04:00"), entry.id);
      assert.ok(Date.parse(intent.window.start) < Date.parse(intent.window.end), entry.id);
      assert.equal(intent.budgetUsd, partyBudgetFor(entry).max, entry.id);
      assert.equal(intent.singleStop, entry.constraints.single_stop, entry.id);
      assert.equal(intent.stopTypes.length === 1, entry.constraints.single_stop, entry.id);
      assert.equal(new Set(intent.stopTypes).size, intent.stopTypes.length, `${entry.id} repeats a stop type`);
    }
  });

  it("reads the whole-party budget, not the per-person label (nc-002)", () => {
    assert.equal(intentFromCase(caseById("nc-002")).budgetUsd, 160);
  });

  it("builds nc-001 from its constraints and keywords", () => {
    assert.deepEqual(intentFromCase(caseById("nc-001")), {
      area: "Manhattan, New York",
      window: { start: "2026-10-23T19:00:00-04:00", end: "2026-10-23T23:30:00-04:00" },
      budgetUsd: 150,
      dietary: [],
      vibeTags: ["romantic", "cocktails"],
      stopTypes: ["drinks", "dinner"],
      singleStop: false,
    });
  });

  it("runs late windows past midnight and keeps the day of the week", () => {
    const lateNight = CASES.find((entry) => entry.constraints.time_window === "late-night");
    assert.ok(lateNight);
    const { window } = intentFromCase(lateNight);
    assert.ok(window.start.includes("T23:00:00"));
    assert.ok(window.end.includes("T03:00:00"));
    assert.notEqual(window.start.slice(0, 10), window.end.slice(0, 10));
  });

  it("joins a multi-borough case into one area", () => {
    const multi = CASES.find((entry) => entry.constraints.boroughs.length > 1);
    assert.ok(multi);
    assert.equal(intentFromCase(multi).area, "Brooklyn and Manhattan, New York");
  });
});
