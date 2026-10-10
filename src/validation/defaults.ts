/**
 * Shared validator / config defaults.
 *
 * `budgetUsd` is the party's total for the night. `estimatedCostUsd` is each
 * stop's total for the whole party. The validator sums stop totals against
 * `budgetUsd`.
 *
 * PRICE_LEVEL_* USD ranges are **heuristics**, not from Google. They are
 * **per person**. The validator compares `estimatedCostUsd / partySize`
 * (default `DEFAULT_PARTY_SIZE`) against those ranges.
 */
export const DEFAULT_TRAVEL_CAP_MINUTES = 25;
export const DEFAULT_TRAVEL_TOLERANCE_MINUTES = 5;
/** Wall-clock budget for one validation's travel calls. */
export const DEFAULT_TRAVEL_BUDGET_MS = 6000;
/** Couples by default (decision-log #1). */
export const DEFAULT_PARTY_SIZE = 2;

export const DEFAULT_PRICE_RANGES = {
  PRICE_LEVEL_FREE: [0, 0],
  PRICE_LEVEL_INEXPENSIVE: [0, 40],
  PRICE_LEVEL_MODERATE: [20, 120],
  PRICE_LEVEL_EXPENSIVE: [80, 250],
  PRICE_LEVEL_VERY_EXPENSIVE: [150, 1000],
} as const satisfies Record<string, readonly [number, number]>;

export type PriceLevelKey = keyof typeof DEFAULT_PRICE_RANGES;
export type PriceRanges = Partial<Record<PriceLevelKey, readonly [number, number]>>;
