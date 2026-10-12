import type { EvalCase } from "./cases";

/**
 * Whole-party budgets for the frozen v1 cases (decision #41: a budget is
 * for the whole party). `nightcap_eval_cases_v1.json` stays frozen, so the
 * one reading it cannot express is applied here.
 *
 * Every v1 case is classified exactly once, and a test fails if one is in
 * neither table:
 *   - PER_PERSON: the query states the budget per person. It maps to an
 *     explicit party min and max.
 *   - PARTY_TOTAL: the query states no per-person basis ("total for two",
 *     or a bare "budget $150"). The case's own `budget_min`/`budget_max`
 *     already are the party budget, matching decision #25 (`budgetUsd` is
 *     the party's total).
 *
 * Each entry cites the query wording it came from. A `note` marks a case
 * where party size or basis is not settled by the query.
 */

export interface PartyBudget {
  readonly min: number;
  readonly max: number;
}

export interface PerPersonEntry extends PartyBudget {
  readonly wording: string;
  readonly partySize: number;
  readonly note?: string;
}

export interface PartyTotalEntry {
  readonly wording: string;
  readonly note?: string;
}

/**
 * nc-002 is the only v1 query that states a per-person budget. It does not
 * state a party size. Two is assumed, the same default as decision #25's
 * couple. The frozen 40-80 band scaled by two is 80-160, which holds the
 * 2 x $60 = $120 a correct parse yields.
 */
export const PER_PERSON: Readonly<Record<string, PerPersonEntry>> = {
  "nc-002": {
    wording: "Max $60 per person",
    partySize: 2,
    min: 80,
    max: 160,
    note: "Party size is not in the query. Two is assumed (decision #25 default). At three people the cap would be $180.",
  },
};

export const PARTY_TOTAL: Readonly<Record<string, PartyTotalEntry>> = {
  "nc-001": { wording: "under $150 total" },
  "nc-003": { wording: "budget around $100" },
  "nc-004": { wording: "Budget $200-250" },
  "nc-005": { wording: "Under $40" },
  "nc-006": { wording: "Mid budget", note: "No figure in the query; the 90-160 range is the label and is kept as the party range." },
  "nc-007": { wording: "Budget up to $300" },
  "nc-008": { wording: "around $80" },
  "nc-009": { wording: "budget $120" },
  "nc-010": { wording: "Not too expensive, under $90", note: "\"Not too expensive\" is vague; the figure \"under $90\" is read as the party total." },
  "nc-011": { wording: "Budget $150" },
  "nc-012": { wording: "under $70" },
  "nc-013": { wording: "Budget $180" },
  "nc-014": { wording: "Around $100" },
  "nc-015": { wording: "Budget $160" },
  "nc-016": { wording: "Budget under $120" },
  "nc-017": { wording: "around $50" },
  "nc-018": { wording: "under $80" },
  "nc-019": { wording: "Budget $200" },
  "nc-020": { wording: "under $90" },
  "nc-021": { wording: "budget $180" },
  "nc-022": { wording: "under $50 total" },
  "nc-023": { wording: "Budget $140" },
  "nc-024": { wording: "Under $100", note: "Family-friendly implies a party larger than two, but the query gives no size and \"Under $100\" does not say per person. Read as the party total." },
  "nc-025": { wording: "budget $130" },
  "nc-026": { wording: "Around $60" },
  "nc-027": { wording: "budget $150" },
  "nc-028": { wording: "Budget $100" },
  "nc-029": { wording: "under $70" },
  "nc-030": { wording: "Budget $250" },
  "nc-031": { wording: "Budget $110" },
  "nc-032": { wording: "Very budget friendly, under $60", note: "\"Very budget friendly\" is vague; the figure \"under $60\" is read as the party total." },
  "nc-033": { wording: "budget $140" },
  "nc-034": { wording: "Under $45" },
  "nc-035": { wording: "Budget $170" },
  "nc-036": { wording: "under $100" },
  "nc-037": { wording: "Budget $90" },
  "nc-038": { wording: "budget $280" },
  "nc-039": { wording: "under $80" },
  "nc-040": { wording: "Budget $150" },
  "nc-041": { wording: "Budget $100" },
  "nc-042": { wording: "Under $80" },
  "nc-043": { wording: "Budget $170" },
  "nc-044": { wording: "under $40" },
  "nc-045": { wording: "budget $160" },
  "nc-046": { wording: "Under $100" },
  "nc-047": { wording: "budget $180", note: "\"Fun group night\" implies a party larger than two, but the query gives no size and \"budget $180\" does not say per person. Read as the party total." },
  "nc-048": { wording: "Budget $90" },
  "nc-049": { wording: "budget $50" },
  "nc-050": { wording: "Budget $140" },
  "nc-051": { wording: "Under $80" },
  "nc-052": { wording: "Budget $220" },
  "nc-053": { wording: "under $70" },
  "nc-054": { wording: "Around $55" },
  "nc-055": { wording: "budget $100" },
  "nc-056": { wording: "budget under $40" },
  "nc-057": { wording: "budget $190" },
  "nc-058": { wording: "budget $120" },
  "nc-059": { wording: "budget $200" },
  "nc-060": { wording: "Under $80" },

};

/** The party budget a case is scored and baselined against. Pure. */
export function partyBudgetFor(evalCase: EvalCase): PartyBudget {
  const perPerson = PER_PERSON[evalCase.id];
  if (perPerson !== undefined) {
    return { min: perPerson.min, max: perPerson.max };
  }
  return { min: evalCase.constraints.budget_min, max: evalCase.constraints.budget_max };
}

/** Party budgets keyed by case id, for `scoreRecords`. */
export function partyBudgetsById(cases: readonly EvalCase[]): ReadonlyMap<string, PartyBudget> {
  return new Map(cases.map((evalCase) => [evalCase.id, partyBudgetFor(evalCase)]));
}
