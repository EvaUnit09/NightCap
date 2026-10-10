import { z } from "zod";

import { MAX_TRAVEL_LEGS_PER_REQUEST_DEFAULT } from "./bounds";
import type { Candidate } from "./candidate";
import { candidateSchema } from "./candidate";
import {
  DEFAULT_PARTY_SIZE,
  DEFAULT_PRICE_RANGES,
  DEFAULT_TRAVEL_BUDGET_MS,
  DEFAULT_TRAVEL_CAP_MINUTES,
  DEFAULT_TRAVEL_TOLERANCE_MINUTES,
  type PriceLevelKey,
  type PriceRanges,
} from "./defaults";
import type { Intent } from "./intent";
import { intentSchema } from "./intent";
import { itineraryOptionSchemaFor, itinerarySchemaFor } from "./itinerary";
import {
  singleStopMatchesIntent,
  stampSingleStopFromIntent,
} from "./single-stop";
import {
  isSupportedTravelMode,
  normalizeTravelMode,
  type TravelCalculator,
  type TravelLeg,
} from "./travel";
import {
  validationErrorSchema,
  type ValidationError,
} from "./validation-error";

export {
  DEFAULT_PARTY_SIZE,
  DEFAULT_PRICE_RANGES,
  DEFAULT_TRAVEL_BUDGET_MS,
  DEFAULT_TRAVEL_CAP_MINUTES,
  DEFAULT_TRAVEL_TOLERANCE_MINUTES,
  type PriceLevelKey,
  type PriceRanges,
} from "./defaults";

export interface ValidatorInput {
  intent: unknown;
  candidates: unknown;
  itinerary: unknown;
}

export interface ValidatorOptions {
  /** Max travel minutes between stops. Default DEFAULT_TRAVEL_CAP_MINUTES. */
  travelCapMinutes?: number;
  /**
   * Travel calculator. No production default.
   * Omit it (or return null/NaN/Infinity / throw) and every hop fails closed.
   */
  travelCalculator?: TravelCalculator;
  /** |claimed − computed| above this emits travel_mismatch. */
  travelToleranceMinutes?: number;
  /**
   * Inclusive heuristic per-person USD ranges per PRICE_LEVEL_*.
   * Not from Google. Compared to estimatedCostUsd / partySize.
   * UNSPECIFIED skips the check.
   */
  priceRanges?: PriceRanges;
  /**
   * Party size used to convert each stop's party-total estimatedCostUsd
   * into a per-person figure for PRICE_LEVEL ranges. Default 2 (couples).
   */
  partySize?: number;
  /**
   * Wall-clock budget for this validation's travel calls.
   * Default DEFAULT_TRAVEL_BUDGET_MS. Exhausted budget fails closed.
   */
  travelBudgetMs?: number;
  /**
   * Cap on travel legs per request, summed across options (stops − 1 each).
   * Default MAX_TRAVEL_LEGS_PER_REQUEST_DEFAULT. Exceeding it is invalid_format.
   */
  maxLegs?: number;
}

const MESSAGE_MAX = 300;
const NYC_TIME_ZONE = "America/New_York";

interface PendingTravel {
  optionIndex: number;
  stopIndex: number;
  placeId: string;
  fromName: string;
  toName: string;
  claimedMinutes: number;
  from: { lat: number; lng: number } | null;
  to: { lat: number; lng: number } | null;
  mode: TravelLeg["mode"];
  departureTime: string;
}

interface ValidationItinerary {
  singleStop?: boolean;
  options: Array<{
    theme: string;
    stops: Array<{
      placeId: string;
      name: string;
      start: string;
      end: string;
      estimatedCostUsd: number;
      why: string;
      travelToNext: { mode: string; minutes: number } | null;
    }>;
  }>;
}

type SharedItineraryParse =
  | { success: true; data: ValidationItinerary }
  | { success: false; error: z.ZodError };

/**
 * Deterministic itinerary validator.
 *
 * Pure: no `server-only`, no config import, no network. Thresholds and the
 * travel calculator are parameters. A sync or async calculator return is allowed.
 *
 * Checks: invented venue, operational, open in America/New_York, name match,
 * budget (sum of each stop's party-total estimatedCostUsd vs party-total
 * budgetUsd), price-level plausibility (per-person ranges vs
 * estimatedCostUsd / partySize), travel max(claimed, computed) ≤ cap,
 * claimed-vs-computed tolerance, travel-leg cap (`maxLegs`, #28) via
 * `itinerarySchemaFor`, intent/itinerary singleStop agreement via
 * `singleStopMatchesIntent`.
 *
 * Callable from the pipeline, repair loop, agent `validate_itinerary` tool,
 * and the eval runner via `src/validation/validator`.
 */
export async function validateItinerary(
  input: ValidatorInput,
  options: ValidatorOptions = {}
): Promise<ValidationError[]> {
  const intentParse = intentSchema.safeParse(input.intent);
  if (!intentParse.success) {
    return [
      emitError({
        code: "invalid_format",
        message: `Invalid intent: ${formatZodError(intentParse.error)}`,
      }),
    ];
  }
  const intent: Intent = intentParse.data;

  if (!singleStopMatchesIntent(input.itinerary, intent.singleStop)) {
    return [
      emitError({
        code: "invalid_format",
        message: `itinerary.singleStop (${displaySingleStop(input.itinerary)}) does not match intent.singleStop (${intent.singleStop})`,
      }),
    ];
  }

  const stamped = isRecord(input.itinerary)
    ? stampSingleStopFromIntent(input.itinerary, intent.singleStop)
    : stampSingleStopFromIntent({}, intent.singleStop);

  const maxLegs =
    options.maxLegs !== undefined && options.maxLegs > 0
      ? options.maxLegs
      : MAX_TRAVEL_LEGS_PER_REQUEST_DEFAULT;

  const itineraryParse = parseSharedItinerary(stamped, intent.singleStop, maxLegs);
  if (!itineraryParse.success) {
    return [
      emitError({
        code: "invalid_format",
        message: `Invalid itinerary: ${formatZodError(itineraryParse.error)}`,
      }),
    ];
  }

  const errors: ValidationError[] = [];
  const itinerary = itineraryParse.data;
  const candidates = parseCandidates(input.candidates);
  const travelCapMinutes = options.travelCapMinutes ?? DEFAULT_TRAVEL_CAP_MINUTES;
  const travelToleranceMinutes =
    options.travelToleranceMinutes ?? DEFAULT_TRAVEL_TOLERANCE_MINUTES;
  const priceRanges = { ...DEFAULT_PRICE_RANGES, ...options.priceRanges };
  const partySize =
    options.partySize !== undefined && options.partySize > 0
      ? options.partySize
      : DEFAULT_PARTY_SIZE;

  const candidateMap = new Map(
    candidates.map((candidate) => [candidate.placeId, candidate])
  );
  const pendingTravel: PendingTravel[] = [];

  for (const [optionIndex, option] of itinerary.options.entries()) {
    let totalCostUsd = 0;

    for (const [stopIndex, stop] of option.stops.entries()) {
      const candidate = candidateMap.get(stop.placeId);
      totalCostUsd += stop.estimatedCostUsd;

      if (!candidate) {
        errors.push(
          emitError({
            code: "invented_venue",
            message: `Place ID ${stop.placeId} is not in the candidate list`,
            optionIndex,
            stopIndex,
            placeId: stop.placeId,
          })
        );
      } else {
        if (!namesMatch(stop.name, candidate.name)) {
          errors.push(
            emitError({
              code: "name_mismatch",
              message: `Stop name "${stop.name}" does not match candidate "${candidate.name}"`,
              optionIndex,
              stopIndex,
              placeId: stop.placeId,
            })
          );
        }

        if (candidate.businessStatus !== "OPERATIONAL") {
          errors.push(
            emitError({
              code: "not_operational",
              message: `${candidate.name} is ${candidate.businessStatus}`,
              optionIndex,
              stopIndex,
              placeId: stop.placeId,
            })
          );
        } else if (!isOpenDuringSlot(candidate, stop.start, stop.end)) {
          errors.push(
            emitError({
              code: "closed",
              message: `${candidate.name} is closed during ${stop.start} to ${stop.end}`,
              optionIndex,
              stopIndex,
              placeId: stop.placeId,
            })
          );
        }

        const priceError = implausibleCostError(
          candidate,
          stop.estimatedCostUsd,
          partySize,
          priceRanges,
          optionIndex,
          stopIndex
        );
        if (priceError) {
          errors.push(priceError);
        }
      }

      if (stop.travelToNext !== null) {
        const nextStop = option.stops[stopIndex + 1];
        const nextCandidate = nextStop
          ? candidateMap.get(nextStop.placeId)
          : undefined;
        pendingTravel.push({
          optionIndex,
          stopIndex,
          placeId: stop.placeId,
          fromName: candidate?.name ?? stop.name,
          toName: nextCandidate?.name ?? nextStop?.name ?? "next stop",
          claimedMinutes: stop.travelToNext.minutes,
          from: candidate?.location ?? null,
          to: nextCandidate?.location ?? null,
          mode: stop.travelToNext.mode,
          departureTime: stop.end,
        });
      }
    }

    if (totalCostUsd > intent.budgetUsd) {
      errors.push(
        emitError({
          code: "over_budget",
          message: `Option ${optionIndex + 1} total cost $${totalCostUsd} exceeds budget $${intent.budgetUsd}`,
          optionIndex,
        })
      );
    }
  }

  const computed = await computeTravel(
    options.travelCalculator,
    pendingTravel,
    options.travelBudgetMs ?? DEFAULT_TRAVEL_BUDGET_MS
  );
  for (const [index, leg] of pendingTravel.entries()) {
    applyTravelRules(
      errors,
      leg,
      computed[index] ?? null,
      travelCapMinutes,
      travelToleranceMinutes
    );
  }

  return errors;
}

function parseCandidates(input: unknown): Candidate[] {
  const asArray = Array.isArray(input) ? input : [];
  const parsed: Candidate[] = [];
  for (const item of asArray) {
    const result = candidateSchema.safeParse(item);
    if (result.success) {
      parsed.push(result.data);
    }
  }
  return parsed;
}

function implausibleCostError(
  candidate: Candidate,
  claimedPartyUsd: number,
  partySize: number,
  priceRanges: Record<PriceLevelKey, readonly [number, number]>,
  optionIndex: number,
  stopIndex: number
): ValidationError | null {
  const level = candidate.priceLevel;
  if (level === null || level === "PRICE_LEVEL_UNSPECIFIED") {
    return null;
  }
  const range = priceRanges[level];
  if (!range) {
    return null;
  }
  const [min, max] = range;
  const perPersonUsd = claimedPartyUsd / partySize;
  if (perPersonUsd >= min && perPersonUsd <= max) {
    return null;
  }
  return emitError({
    code: "implausible_cost",
    message: `Claimed $${claimedPartyUsd} ($${formatUsd(perPersonUsd)}/person for ${partySize}) is outside ${level} range $${min}–$${max} (heuristic, per person)`,
    optionIndex,
    stopIndex,
    placeId: candidate.placeId,
  });
}

function formatUsd(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

async function computeTravel(
  calculator: TravelCalculator | undefined,
  pending: PendingTravel[],
  travelBudgetMs: number
): Promise<Array<number | null>> {
  if (pending.length === 0) {
    return [];
  }
  if (!calculator) {
    return pending.map(() => null);
  }

  const unique: TravelLeg[] = [];
  const uniqueIndexFor = pending.map(() => 0);
  const seen = new Map<string, number>();
  for (const [index, leg] of pending.entries()) {
    const travelLeg: TravelLeg = {
      from: leg.from,
      to: leg.to,
      mode: leg.mode,
      departureTime: leg.departureTime,
    };
    const key = travelLegKey(travelLeg);
    const existing = seen.get(key);
    if (existing !== undefined) {
      uniqueIndexFor[index] = existing;
      continue;
    }
    seen.set(key, unique.length);
    uniqueIndexFor[index] = unique.length;
    unique.push(travelLeg);
  }

  try {
    const result = await withBudget(
      Promise.resolve(calculator.calculateMinutes(unique)),
      travelBudgetMs
    );
    if (result === undefined) {
      return pending.map(() => null);
    }
    if (!Array.isArray(result) || result.length !== unique.length) {
      return pending.map(() => null);
    }
    return uniqueIndexFor.map((uniqueIndex) => result[uniqueIndex] ?? null);
  } catch {
    return pending.map(() => null);
  }
}

function travelLegKey(leg: TravelLeg): string {
  return JSON.stringify({
    from: leg.from,
    to: leg.to,
    mode: leg.mode,
    departureTime:
      normalizeTravelMode(leg.mode) === "TRANSIT"
        ? (leg.departureTime ?? null)
        : null,
  });
}

function withBudget<T>(promise: Promise<T>, budgetMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), budgetMs);
  });
  // Attach a handler now so a late reject after the budget wins is not unhandled.
  const guarded = promise.catch(() => undefined);
  return Promise.race([guarded, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

function applyTravelRules(
  errors: ValidationError[],
  leg: PendingTravel,
  computed: number | null,
  travelCapMinutes: number,
  travelToleranceMinutes: number
): void {
  if (!isSupportedTravelMode(leg.mode)) {
    errors.push(
      emitError({
        code: "travel_unverified",
        message: `Travel mode "${leg.mode}" is not supported; v1 allows TRANSIT, BICYCLE, and WALK`,
        optionIndex: leg.optionIndex,
        stopIndex: leg.stopIndex,
        placeId: leg.placeId,
      })
    );
    return;
  }

  if (leg.from === null || leg.to === null) {
    errors.push(
      emitError({
        code: "travel_unverified",
        message: `Cannot compute travel from ${leg.fromName} to ${leg.toName}: missing coordinates`,
        optionIndex: leg.optionIndex,
        stopIndex: leg.stopIndex,
        placeId: leg.placeId,
      })
    );
    return;
  }

  const invalid =
    computed === null ||
    Number.isNaN(computed) ||
    !Number.isFinite(computed) ||
    computed < 0;

  if (invalid) {
    errors.push(
      emitError({
        code: "travel_unverified",
        message: `Travel calculation failed from ${leg.fromName} to ${leg.toName}`,
        optionIndex: leg.optionIndex,
        stopIndex: leg.stopIndex,
        placeId: leg.placeId,
      })
    );
    return;
  }

  const effective = Math.max(leg.claimedMinutes, computed);
  if (effective > travelCapMinutes) {
    errors.push(
      emitError({
        code: "travel_too_long",
        message: `Travel from ${leg.fromName} to ${leg.toName} is ${effective} min (cap: ${travelCapMinutes} min)`,
        optionIndex: leg.optionIndex,
        stopIndex: leg.stopIndex,
        placeId: leg.placeId,
      })
    );
  }

  if (Math.abs(leg.claimedMinutes - computed) > travelToleranceMinutes) {
    errors.push(
      emitError({
        code: "travel_mismatch",
        message: `Travel from ${leg.fromName} to ${leg.toName}: claimed ${leg.claimedMinutes} min vs computed ${computed} min (tolerance: ${travelToleranceMinutes} min)`,
        optionIndex: leg.optionIndex,
        stopIndex: leg.stopIndex,
        placeId: leg.placeId,
      })
    );
  }
}

function emitError(error: ValidationError): ValidationError {
  const candidate = {
    ...error,
    message: truncateMessage(error.message),
  };
  return validationErrorSchema.parse(candidate);
}

function truncateMessage(message: string): string {
  if (message.length <= MESSAGE_MAX) {
    return message;
  }
  return `${message.slice(0, MESSAGE_MAX - 3)}...`;
}

function formatZodError(error: z.ZodError): string {
  return z.prettifyError(error);
}

function namesMatch(left: string, right: string): boolean {
  return normalizeName(left) === normalizeName(right);
}

function normalizeName(name: string): string {
  return name
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .trim()
    .toLowerCase();
}

function parseSharedItinerary(
  raw: unknown,
  singleStop: boolean,
  maxLegs: number
): SharedItineraryParse {
  const direct = parseWithSharedSchemas(raw, singleStop, maxLegs);
  if (direct.success) {
    return direct;
  }

  const structural = direct.error.issues.filter((issue) => !isTravelModeIssue(issue));
  if (structural.length > 0) {
    return { success: false, error: new z.ZodError(structural) };
  }

  // Unsupported hop modes fail the shared enum before refinements run.
  // Retry with a schema-valid placeholder so chronology / unique-venue still
  // apply, then restore the original mode for travel_unverified.
  const retry = parseWithSharedSchemas(
    coerceHopModesForSchema(raw),
    singleStop,
    maxLegs
  );
  if (!retry.success) {
    return retry;
  }
  return { success: true, data: restoreHopModes(retry.data, raw) };
}

function parseWithSharedSchemas(
  raw: unknown,
  singleStop: boolean,
  maxLegs: number
): SharedItineraryParse {
  const shared = itinerarySchemaFor({ maxLegs }).safeParse(raw);
  if (!shared.success) {
    return { success: false, error: shared.error };
  }

  const optionSchema = itineraryOptionSchemaFor(singleStop);
  const optionIssues: z.core.$ZodIssue[] = [];
  for (const option of shared.data.options) {
    const parsed = optionSchema.safeParse(option);
    if (!parsed.success) {
      optionIssues.push(...parsed.error.issues);
    }
  }
  if (optionIssues.length > 0) {
    return { success: false, error: new z.ZodError(optionIssues) };
  }
  return { success: true, data: shared.data };
}

function coerceHopModesForSchema(raw: unknown): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.options)) {
    return raw;
  }
  return {
    ...raw,
    options: raw.options.map((option) => {
      if (!isRecord(option) || !Array.isArray(option.stops)) {
        return option;
      }
      return {
        ...option,
        stops: option.stops.map((stop) => {
          if (!isRecord(stop) || !isRecord(stop.travelToNext)) {
            return stop;
          }
          return {
            ...stop,
            travelToNext: { ...stop.travelToNext, mode: "WALK" },
          };
        }),
      };
    }),
  };
}

function restoreHopModes(
  parsed: ValidationItinerary,
  raw: unknown
): ValidationItinerary {
  if (!isRecord(raw) || !Array.isArray(raw.options)) {
    return parsed;
  }
  const rawOptions = raw.options;
  return {
    ...parsed,
    options: parsed.options.map((option, optionIndex) => {
      const rawOption = rawOptions[optionIndex];
      if (!isRecord(rawOption) || !Array.isArray(rawOption.stops)) {
        return option;
      }
      const rawStops = rawOption.stops;
      return {
        ...option,
        stops: option.stops.map((stop, stopIndex) => {
          const rawStop = rawStops[stopIndex];
          if (
            !isRecord(rawStop) ||
            !isRecord(rawStop.travelToNext) ||
            stop.travelToNext === null
          ) {
            return stop;
          }
          const mode = rawStop.travelToNext.mode;
          return {
            ...stop,
            travelToNext: {
              ...stop.travelToNext,
              mode: typeof mode === "string" ? mode : stop.travelToNext.mode,
            },
          };
        }),
      };
    }),
  };
}

function isTravelModeIssue(issue: z.core.$ZodIssue): boolean {
  return (
    issue.path.includes("travelToNext") && issue.path[issue.path.length - 1] === "mode"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function displaySingleStop(value: unknown): string {
  if (!isRecord(value) || !("singleStop" in value)) {
    return "false";
  }
  return String(value.singleStop);
}

/**
 * Open-hours check in America/New_York.
 *
 * Only `{ day: 0, hour: 0, minute: 0 }` with no close is 24/7 (Places convention).
 * Any other no-close period is malformed and ignored — it does not open the slot
 * and does not override real hours.
 *
 * FUTURE_OPENING is handled as `not_operational` before this runs.
 */
function isOpenDuringSlot(
  candidate: Candidate,
  slotStart: string,
  slotEnd: string
): boolean {
  const { openingHours } = candidate;
  if (openingHours.length === 0) {
    return false;
  }

  const is24x7 = openingHours.some(
    (period) =>
      period.close === undefined &&
      period.open.day === 0 &&
      period.open.hour === 0 &&
      period.open.minute === 0
  );
  if (is24x7) {
    return true;
  }

  const validPeriods = openingHours.filter(
    (
      period
    ): period is {
      open: { day: number; hour: number; minute: number };
      close: { day: number; hour: number; minute: number };
    } => period.close !== undefined
  );
  if (validPeriods.length === 0) {
    return false;
  }

  const start = parseISOToNYCTime(slotStart);
  const end = parseISOToNYCTime(slotEnd);
  if (start === null || end === null) {
    return false;
  }

  if (start.day === end.day) {
    return checkOpenOnDay(validPeriods, start.day, start.minute, end.minute);
  }

  const nextDay = (start.day + 1) % 7;
  if (end.day !== nextDay) {
    return false;
  }
  return (
    checkOpenOnDay(validPeriods, start.day, start.minute, 24 * 60 - 1) &&
    checkOpenOnDay(validPeriods, end.day, 0, end.minute)
  );
}

function parseISOToNYCTime(
  isoString: string
): { day: number; minute: number } | null {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NYC_TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const dayName = parts.find((part) => part.type === "weekday")?.value;
  let hour = Number.parseInt(
    parts.find((part) => part.type === "hour")?.value ?? "",
    10
  );
  const minute = Number.parseInt(
    parts.find((part) => part.type === "minute")?.value ?? "",
    10
  );
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || !dayName) {
    return null;
  }
  if (hour === 24) {
    hour = 0;
  }

  const dayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const day = dayMap[dayName];
  if (day === undefined) {
    return null;
  }
  return { day, minute: hour * 60 + minute };
}

function checkOpenOnDay(
  openingHours: Array<{
    open: { day: number; hour: number; minute: number };
    close: { day: number; hour: number; minute: number };
  }>,
  day: number,
  startMinute: number,
  endMinute: number
): boolean {
  for (const period of openingHours) {
    const openDay = period.open.day;
    const openMinute = period.open.hour * 60 + period.open.minute;
    const closeDay = period.close.day;
    const closeMinute = period.close.hour * 60 + period.close.minute;

    if (openDay === day && closeDay === day) {
      if (startMinute >= openMinute && endMinute <= closeMinute) {
        return true;
      }
    }

    if (openDay === day && closeDay !== day && startMinute >= openMinute) {
      return true;
    }

    const prevDay = (day + 6) % 7;
    if (
      closeDay === day &&
      openDay === prevDay &&
      endMinute <= closeMinute
    ) {
      return true;
    }
  }
  return false;
}
