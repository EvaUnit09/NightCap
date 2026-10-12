import type { StopType } from "../src/retrieval";
import { intentSchema, type Intent } from "../src/validation/intent";
import type { EvalCase } from "./cases";
import { partyBudgetFor } from "./party-budget";

/**
 * The baselines' deterministic stand-in for `parse_intent` (build step 20).
 *
 * Neither baseline may call the parse model: filter-only has no model at
 * all, and raw-model must not borrow the pipeline's parser. The frozen v1
 * cases already carry hand-labelled constraints, so the intent is built
 * from those instead of from a second, weaker text parser. That keeps the
 * comparison about retrieval and planning, not parsing.
 *
 * What the constraints do not hold is filled by fixed rules:
 *   - date: the weekday names a day in one fixed reference week (all in
 *     EDT, so the offset never changes); "any" is Friday.
 *   - time_window: a fixed clock range per label.
 *   - budget: the top of the case's whole-party budget (`party-budget.ts`,
 *     decision #41), so a baseline is never failed for being cheaper than
 *     the label.
 *   - stop types: keyword rules over the query, tags, and vibes, ordered
 *     as a night flows, padded from a default order up to the lower bound
 *     of `stops_per_option` (at least 2 unless `single_stop`).
 */

/** Monday 2026-10-19 to Sunday 2026-10-25. Before the first Sunday of November, so EDT. */
const REFERENCE_DATE: Readonly<Record<string, string>> = {
  Monday: "2026-10-19",
  Tuesday: "2026-10-20",
  Wednesday: "2026-10-21",
  Thursday: "2026-10-22",
  Friday: "2026-10-23",
  Saturday: "2026-10-24",
  Sunday: "2026-10-25",
  any: "2026-10-23",
};
const NYC_OFFSET = "-04:00";
const MS_PER_HOUR = 3_600_000;

/** Local start hour and length in hours. Late windows run past midnight. */
const TIME_WINDOWS: Readonly<Record<string, { readonly startHour: number; readonly hours: number }>> = {
  afternoon: { startHour: 14, hours: 4 },
  "afternoon-evening": { startHour: 15, hours: 7 },
  "early-evening": { startHour: 17, hours: 4 },
  evening: { startHour: 19, hours: 4.5 },
  "late-evening": { startHour: 21, hours: 4 },
  "late-night": { startHour: 23, hours: 4 },
};
const DEFAULT_TIME_WINDOW = TIME_WINDOWS.evening;

export const INTENT_TAGS_MAX = 8;
const STOP_COUNT_MAX = 4;
const STOP_COUNT_MIN_MULTI = 2;

/** Order a night flows, and so the order matched types are kept in. */
const FLOW_ORDER: readonly StopType[] = ["dinner", "activity", "dessert", "drinks", "bar"];
const PADDING_ORDER: readonly StopType[] = ["dinner", "drinks", "dessert", "activity", "bar"];

const KEYWORDS: Readonly<Record<StopType, readonly string[]>> = {
  dinner: [
    "dinner", "restaurant", "food", "foodie", "italian", "sushi", "steak", "pizza", "tacos", "seafood",
    "korean", "vegan", "vegetarian", "gluten", "halal", "small plates", "street food", "fine dining",
  ],
  activity: ["comedy", "jazz", "live music", "museum", "gallery", "cultural", "karaoke", "bowling", "board games", "theater"],
  dessert: ["dessert", "ice cream", "cake"],
  drinks: ["cocktail", "cocktails", "wine", "speakeasy", "rooftop", "drinks", "nightcap"],
  bar: ["bar", "bars", "beer", "pub", "dive", "crawl", "brewery", "party", "dancing"],
};

function wordPattern(terms: readonly string[]): RegExp {
  return new RegExp(`\\b(?:${terms.join("|")})\\b`, "i");
}

const KEYWORD_PATTERNS = FLOW_ORDER.map((stopType) => [stopType, wordPattern(KEYWORDS[stopType])] as const);

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** A wall-clock instant (held in the UTC fields of `localMs`) as an ISO string with the fixed NYC offset. */
function localIso(localMs: number): string {
  return `${new Date(localMs).toISOString().slice(0, 19)}${NYC_OFFSET}`;
}

function windowFor(evalCase: EvalCase): Intent["window"] {
  const { day_of_week: day, time_window: label } = evalCase.constraints;
  const date = REFERENCE_DATE[day] ?? REFERENCE_DATE.any;
  const { startHour, hours } = TIME_WINDOWS[label] ?? DEFAULT_TIME_WINDOW;
  // The UTC fields of this Date hold the local wall clock; nothing here reads the host timezone.
  const startMs = Date.parse(`${date}T${pad2(startHour)}:00:00Z`);
  return { start: localIso(startMs), end: localIso(startMs + hours * MS_PER_HOUR) };
}

function stopCountFor(stopsPerOption: string): number {
  const lower = Number(stopsPerOption.split("-")[0]);
  return Math.min(Math.max(lower, STOP_COUNT_MIN_MULTI), STOP_COUNT_MAX);
}

function stopTypesFor(evalCase: EvalCase): StopType[] {
  const { single_stop: singleStop, stops_per_option: perOption, vibes } = evalCase.constraints;
  const text = [evalCase.query, ...evalCase.tags, ...vibes].join(" ").replaceAll("-", " ");
  const matched = KEYWORD_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([stopType]) => stopType);
  const count = singleStop ? 1 : stopCountFor(perOption);
  const padding = PADDING_ORDER.filter((stopType) => !matched.includes(stopType));
  return [...matched, ...padding].slice(0, count);
}

/**
 * The intent a baseline plans and validates against. Pure. Throws if the
 * result breaks `intentSchema`, which would mean a case the rules cannot map.
 */
export function intentFromCase(evalCase: EvalCase): Intent {
  const { constraints } = evalCase;
  return intentSchema.parse({
    area: `${constraints.boroughs.join(" and ")}, New York`,
    window: windowFor(evalCase),
    budgetUsd: Math.round(partyBudgetFor(evalCase).max),
    dietary: constraints.dietary.slice(0, INTENT_TAGS_MAX),
    vibeTags: constraints.vibes.slice(0, INTENT_TAGS_MAX),
    stopTypes: stopTypesFor(evalCase),
    singleStop: constraints.single_stop,
  });
}
