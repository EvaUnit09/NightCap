/**
 * Shared validator / config defaults.
 *
 * PRICE_LEVEL_* USD ranges are **heuristics**, not from Google. They are
 * **per person** (one guest's spend at that stop), used only to flag
 * implausible claimed costs.
 */
export const DEFAULT_TRAVEL_CAP_MINUTES = 25;
export const DEFAULT_TRAVEL_TOLERANCE_MINUTES = 5;
/** Wall-clock budget for one validation's travel calls. */
export const DEFAULT_TRAVEL_BUDGET_MS = 6000;

export const DEFAULT_PRICE_RANGES = {
  PRICE_LEVEL_FREE: [0, 0],
  PRICE_LEVEL_INEXPENSIVE: [0, 40],
  PRICE_LEVEL_MODERATE: [20, 120],
  PRICE_LEVEL_EXPENSIVE: [80, 250],
  PRICE_LEVEL_VERY_EXPENSIVE: [150, 1000],
} as const satisfies Record<string, readonly [number, number]>;

export type PriceLevelKey = keyof typeof DEFAULT_PRICE_RANGES;
export type PriceRanges = Partial<Record<PriceLevelKey, readonly [number, number]>>;
