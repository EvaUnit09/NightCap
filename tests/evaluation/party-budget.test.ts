import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadEvalCasesV1 } from "../../evaluation/cases";
import { PARTY_TOTAL, PER_PERSON, partyBudgetFor, partyBudgetsById } from "../../evaluation/party-budget";

const CASES = loadEvalCasesV1();

describe("v1 party budgets", () => {
  it("classifies every v1 case exactly once and lists nothing else", () => {
    const perPerson = Object.keys(PER_PERSON);
    const partyTotal = Object.keys(PARTY_TOTAL);
    assert.deepEqual(perPerson.filter((id) => partyTotal.includes(id)), [], "a case is in both tables");
    const classified = new Set([...perPerson, ...partyTotal]);
    assert.deepEqual(CASES.filter((c) => !classified.has(c.id)).map((c) => c.id), [], "unclassified cases");
    assert.deepEqual([...classified].filter((id) => !CASES.some((c) => c.id === id)), [], "ids not in v1");
  });

  it("cites wording that really appears in each case's query", () => {
    for (const c of CASES) {
      const entry = PER_PERSON[c.id] ?? PARTY_TOTAL[c.id];
      assert.ok(c.query.toLowerCase().includes(entry.wording.toLowerCase()), `${c.id}: "${entry.wording}"`);
    }
  });

  it("keeps per-person wording in PER_PERSON and out of PARTY_TOTAL", () => {
    const perPersonWording = /per (person|head)/i;
    for (const [id, entry] of Object.entries(PER_PERSON)) {
      assert.match(entry.wording, perPersonWording, `${id}: PER_PERSON wording`);
    }
    for (const c of CASES.filter((entry) => entry.id in PARTY_TOTAL)) {
      assert.doesNotMatch(c.query, perPersonWording, `${c.id}: a per-person query is filed as a party total`);
    }
  });

  it("scales a per-person budget by the stated party size", () => {
    for (const [id, entry] of Object.entries(PER_PERSON)) {
      const labelled = CASES.find((c) => c.id === id)?.constraints;
      assert.ok(labelled, id);
      assert.equal(entry.min, labelled.budget_min * entry.partySize, id);
      assert.equal(entry.max, labelled.budget_max * entry.partySize, id);
    }
  });

  it("leaves party-total cases on their own labelled range", () => {
    for (const c of CASES.filter((entry) => entry.id in PARTY_TOTAL)) {
      assert.deepEqual(partyBudgetFor(c), { min: c.constraints.budget_min, max: c.constraints.budget_max }, c.id);
    }
  });

  it("gives nc-002 the two-person budget and indexes every case", () => {
    const budgets = partyBudgetsById(CASES);
    assert.equal(budgets.size, CASES.length);
    assert.deepEqual(budgets.get("nc-002"), { min: 80, max: 160 });
    assert.deepEqual(budgets.get("nc-001"), { min: 80, max: 150 });
  });
});
