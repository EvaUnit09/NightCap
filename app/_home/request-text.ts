import type { TravelMode } from "../../src/validation/common";

export const REQUEST_TEXT_MAX_CHARS = 8 * 1024;

export type WhenChoice = "tonight" | "tomorrow" | "this_friday";

export const BUDGET_PRESETS_USD = [75, 150, 250] as const;
export type BudgetPresetUsd = (typeof BUDGET_PRESETS_USD)[number];

declare const budgetUsdBrand: unique symbol;
/** Whole dollars for the whole party, 1..BUDGET_CUSTOM_MAX_USD. Built only by `parseCustomBudget`. */
export type CustomBudgetUsd = number & { readonly [budgetUsdBrand]: true };
export const BUDGET_CUSTOM_MAX_USD = 100_000;

export type BudgetChoice =
  | { readonly kind: "preset"; readonly usd: BudgetPresetUsd }
  | { readonly kind: "custom"; readonly usd: CustomBudgetUsd };

export interface ApproxLocation {
  readonly lat: number;
  readonly lng: number;
}

/**
 * Chip overrides. `null` means "not chosen, defer to the parser". A chip is
 * shown as selected exactly when its field is non-null.
 */
export interface Overrides {
  readonly when: WhenChoice | null;
  readonly budget: BudgetChoice | null;
  readonly travel: TravelMode | null;
  readonly near: ApproxLocation | null;
}

export const NO_OVERRIDES: Overrides = { when: null, budget: null, travel: null, near: null };

export interface ChipOption<V> {
  readonly value: V;
  readonly label: string;
}

export interface ChipTable {
  readonly when: { readonly unsetLabel: "Tonight"; readonly options: readonly ChipOption<WhenChoice>[] };
  readonly budget: {
    readonly unsetLabel: "$150 for two";
    readonly options: readonly ChipOption<BudgetPresetUsd>[];
    readonly customLabel: "Custom";
  };
  readonly travel: {
    readonly unsetLabel: "Walking";
    readonly options: readonly ChipOption<TravelMode>[];
  };
}

export const CHIP_TABLE: ChipTable = {
  when: {
    unsetLabel: "Tonight",
    options: [
      { value: "tonight", label: "Tonight" },
      { value: "tomorrow", label: "Tomorrow" },
      { value: "this_friday", label: "This Friday" },
    ],
  },
  budget: {
    unsetLabel: "$150 for two",
    options: BUDGET_PRESETS_USD.map((usd) => ({ value: usd, label: `$${usd} for two` })),
    customLabel: "Custom",
  },
  travel: {
    unsetLabel: "Walking",
    options: [
      { value: "WALK", label: "Walk" },
      { value: "TRANSIT", label: "Subway" },
      { value: "BICYCLE", label: "Bike" },
    ],
  },
};

export const EXAMPLES = [
  "Cocktails then ramen in the East Village",
  "Just dinner, one spot, West Village",
  "First date somewhere we can talk",
  "Something outdoors in Williamsburg",
] as const;

const TRAVEL_WORDS = {
  WALK: "walking",
  TRANSIT: "subway",
  BICYCLE: "bike",
} as const satisfies Record<TravelMode, string>;

const NY_TIME_ZONE = "America/New_York";

interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function civilDateInNy(now: Date): CivilDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: read("year"), month: read("month"), day: read("day") };
}

function addDays(date: CivilDate, days: number): CivilDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function weekdayIndex(date: CivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function formatCivil(date: CivilDate): string {
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(utc);
}

function whenDate(choice: WhenChoice, now: Date): CivilDate {
  const today = civilDateInNy(now);
  switch (choice) {
    case "tonight":
      return today;
    case "tomorrow":
      return addDays(today, 1);
    case "this_friday": {
      const friday = 5;
      return addDays(today, (friday - weekdayIndex(today) + 7) % 7);
    }
    default: {
      const unexpected: never = choice;
      return unexpected;
    }
  }
}

function whenClause(choice: WhenChoice, now: Date): string {
  return `On ${formatCivil(whenDate(choice, now))}`;
}

function budgetClause(usd: number): string {
  return `Budget $${usd} total for the two of us`;
}

function travelClause(mode: TravelMode): string {
  return `Getting around by ${TRAVEL_WORDS[mode]}`;
}

function nearClause(near: ApproxLocation): string {
  return `Near ${near.lat.toFixed(3)}, ${near.lng.toFixed(3)}`;
}

function foldClauses(clauses: readonly string[]): string {
  if (clauses.length === 0) return "";
  return `\n\n${clauses.join(". ")}.`;
}

function longestWhenClause(): string {
  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  let longest = "";
  for (const weekday of weekdays) {
    for (const month of months) {
      const clause = `On ${weekday}, ${month} 30`;
      if (clause.length > longest.length) longest = clause;
    }
  }
  return longest;
}

function longestTravelClause(): string {
  let longest = "";
  for (const option of CHIP_TABLE.travel.options) {
    const clause = travelClause(option.value);
    if (clause.length > longest.length) longest = clause;
  }
  return longest;
}

const NEAR_EXTREME: ApproxLocation = { lat: -90, lng: -180 };

export const OVERRIDE_SUFFIX_MAX_CHARS = foldClauses([
  longestWhenClause(),
  budgetClause(Math.max(BUDGET_CUSTOM_MAX_USD, ...CHIP_TABLE.budget.options.map((option) => option.value))),
  longestTravelClause(),
  nearClause(NEAR_EXTREME),
]).length;

export const TEXTAREA_MAX_CHARS = REQUEST_TEXT_MAX_CHARS - OVERRIDE_SUFFIX_MAX_CHARS;

export function parseCustomBudget(raw: string): CustomBudgetUsd | null {
  const cleaned = raw.trim().replace(/[$,\s]/g, "");
  if (!/^\d+$/.test(cleaned)) return null;
  const usd = Number(cleaned);
  if (!Number.isSafeInteger(usd) || usd < 1 || usd > BUDGET_CUSTOM_MAX_USD) return null;
  return usd as CustomBudgetUsd;
}

export function canSubmit(text: string): boolean {
  return text.trim().length > 0;
}

export function composeRequestText(text: string, overrides: Overrides, now: Date): string {
  const clauses: string[] = [];
  if (overrides.when) clauses.push(whenClause(overrides.when, now));
  if (overrides.budget) clauses.push(budgetClause(overrides.budget.usd));
  if (overrides.travel) clauses.push(travelClause(overrides.travel));
  if (overrides.near) clauses.push(nearClause(overrides.near));
  return `${text.trim()}${foldClauses(clauses)}`;
}

export function chipLabel(chip: keyof ChipTable, overrides: Overrides): string {
  switch (chip) {
    case "when": {
      if (overrides.when === null) return CHIP_TABLE.when.unsetLabel;
      return CHIP_TABLE.when.options.find((option) => option.value === overrides.when)?.label ?? CHIP_TABLE.when.unsetLabel;
    }
    case "budget": {
      if (overrides.budget === null) return CHIP_TABLE.budget.unsetLabel;
      if (overrides.budget.kind === "preset") {
        return (
          CHIP_TABLE.budget.options.find((option) => option.value === overrides.budget?.usd)?.label ??
          CHIP_TABLE.budget.unsetLabel
        );
      }
      return `$${overrides.budget.usd} for two`;
    }
    case "travel": {
      if (overrides.travel === null) return CHIP_TABLE.travel.unsetLabel;
      return (
        CHIP_TABLE.travel.options.find((option) => option.value === overrides.travel)?.label ??
        CHIP_TABLE.travel.unsetLabel
      );
    }
    default: {
      const unexpected: never = chip;
      return unexpected;
    }
  }
}

export function roundCoord(value: number): number {
  return Math.round(value * 1000) / 1000;
}
