import { z } from "zod";

import { STOPS_MAX, STOPS_MIN, STOPS_MIN_SINGLE } from "./bounds";
import type { Candidate } from "./candidate";
import { candidateSchema } from "./candidate";
import { isBefore, isoDateTimeSchema, oneLineSchema, placeIdSchema } from "./common";
import {
  DEFAULT_PRICE_RANGES,
  DEFAULT_TRAVEL_BUDGET_MS,
  DEFAULT_TRAVEL_CAP_MINUTES,
  DEFAULT_TRAVEL_TOLERANCE_MINUTES,
  type PriceLevelKey,
  type PriceRanges,
} from "./defaults";
import type { Intent } from "./intent";
import { intentSchema } from "./intent";
import { itinerarySchema } from "./itinerary";
import {
  isSupportedTravelMode,
  type TravelCalculator,
  type TravelLeg,
} from "./travel";
import {
  validationErrorSchema,
  type ValidationError,
} from "./validation-error";

export {
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
   * Not from Google. UNSPECIFIED skips the check.
   */
  priceRanges?: PriceRanges;
  /**
   * Wall-clock budget for this validation's travel calls.
   * Default DEFAULT_TRAVEL_BUDGET_MS. Exhausted budget fails closed.
   */
  travelBudgetMs?: number;
}

const MESSAGE_MAX = 300;
const NYC_TIME_ZONE = "America/New_York";
const OPTIONS_MIN = 2;
const OPTIONS_MAX = 3;

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

/** Local parse: accept any mode string so bicycle works before #8 updates the enum. */
const validationTravelToNextSchema = z
  .object({
    mode: z.string().trim().min(1).max(40),
    minutes: z.int().nonnegative().max(24 * 60),
  })
  .strict();

const validationStopSchema = z
  .object({
    placeId: placeIdSchema,
    name: z.string().trim().min(1).max(200),
    start: isoDateTimeSchema,
    end: isoDateTimeSchema,
    estimatedCostUsd: z.int().nonnegative().max(100_000),
    why: oneLineSchema(200),
    travelToNext: validationTravelToNextSchema.nullable(),
  })
  .strict()
  .refine((stop) => isBefore(stop.start, stop.end), {
    message: "Stop start must be before stop end",
    path: ["end"],
  });

/**
 * Field shape only. Travel rules, chronological order, unique venues, and
 * #8's exact-1 singleStop bound come from `itinerarySchema` so those
 * refinements are not duplicated here.
 */
const validationOptionSchema = z
  .object({
    theme: oneLineSchema(80),
    stops: z.array(validationStopSchema).min(STOPS_MIN_SINGLE).max(STOPS_MAX),
  })
  .strict();

const validationItinerarySchema = z
  .object({
    options: z.array(validationOptionSchema).min(OPTIONS_MIN).max(OPTIONS_MAX),
  })
  .strict();

/**
 * Deterministic itinerary validator.
 *
 * Pure: no `server-only`, no config import, no network. Thresholds and the
 * travel calculator are parameters. A sync or async calculator return is allowed.
 *
 * Checks: invented venue, operational, open in America/New_York, name match,
 * budget (every stop's cost), price-level plausibility, travel
 * max(claimed, computed) ≤ cap, claimed-vs-computed tolerance,
 * intent/itinerary singleStop agreement.
 *
 * Callable from the pipeline, repair loop, agent `validate_itinerary` tool,
 * and the eval runner via `src/validation/validator`.
 */
export async function validateItinerary(
  input: ValidatorInput,
  options: ValidatorOptions = {}
): Promise<ValidationError[]> {
  const intentFlag = readBooleanField(input.intent, "singleStop");
  const itineraryFlag = readBooleanField(input.itinerary, "singleStop");
  if (!intentFlag.ok || !itineraryFlag.ok) {
    return [
      emitError({
        code: "invalid_format",
        message: "singleStop must be a boolean",
      }),
    ];
  }

  const intentParse = parseKnownSchema(intentSchema, input.intent, ["singleStop"]);
  if (!intentParse.success) {
    return [
      emitError({
        code: "invalid_format",
        message: `Invalid intent: ${formatZodError(intentParse.error)}`,
      }),
    ];
  }

  const errors: ValidationError[] = [];
  const intentSingleStop =
    readParsedBoolean(intentParse.data, "singleStop") ?? intentFlag.value ?? false;
  const itinerarySingleStop = itineraryFlag.value ?? false;

  if (intentSingleStop !== itinerarySingleStop) {
    errors.push(
      emitError({
        code: "invalid_format",
        message: `itinerary.singleStop (${itinerarySingleStop}) does not match intent.singleStop (${intentSingleStop})`,
      })
    );
  }

  const sharedItinerary = parseSharedItinerary(input.itinerary);
  if (!sharedItinerary.success) {
    const structural = sharedItinerary.error.issues.filter(
      (issue) => !isTravelModeIssue(issue)
    );
    if (structural.length > 0) {
      errors.push(
        emitError({
          code: "invalid_format",
          message: `Invalid itinerary: ${formatZodError(
            new z.ZodError(structural)
          )}`,
        })
      );
      return errors;
    }
  }

  const itineraryParse = validationItinerarySchema.safeParse(
    omitKey(input.itinerary, "singleStop")
  );
  if (!itineraryParse.success) {
    if (errors.length > 0) {
      return errors;
    }
    return [
      emitError({
        code: "invalid_format",
        message: `Invalid itinerary: ${formatZodError(itineraryParse.error)}`,
      }),
    ];
  }

  const intent: Intent = intentParse.data;
  const itinerary = itineraryParse.data;
  const candidates = parseCandidates(input.candidates);
  const travelCapMinutes = options.travelCapMinutes ?? DEFAULT_TRAVEL_CAP_MINUTES;
  const travelToleranceMinutes =
    options.travelToleranceMinutes ?? DEFAULT_TRAVEL_TOLERANCE_MINUTES;
  const priceRanges = { ...DEFAULT_PRICE_RANGES, ...options.priceRanges };

  const candidateMap = new Map(
    candidates.map((candidate) => [candidate.placeId, candidate])
  );
  const pendingTravel: PendingTravel[] = [];

  const minStops = intentSingleStop ? STOPS_MIN_SINGLE : STOPS_MIN;

  for (const [optionIndex, option] of itinerary.options.entries()) {
    if (option.stops.length < minStops || option.stops.length > STOPS_MAX) {
      errors.push(
        emitError({
          code: "invalid_format",
          message: `Option ${optionIndex + 1} must have ${minStops}–${STOPS_MAX} stops`,
          optionIndex,
        })
      );
    }

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
          priceRanges,
          optionIndex,
          stopIndex
        );
        if (priceError) {
          errors.push(priceError);
        }
      }

      const isLast = stopIndex === option.stops.length - 1;
      if (!isLast && stop.travelToNext === null) {
        errors.push(
          emitError({
            code: "travel_too_long",
            message: `Stop ${stopIndex} has no travelToNext`,
            optionIndex,
            stopIndex,
            placeId: stop.placeId,
          })
        );
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
  claimedUsd: number,
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
  if (claimedUsd >= min && claimedUsd <= max) {
    return null;
  }
  return emitError({
    code: "implausible_cost",
    message: `Claimed $${claimedUsd} is outside ${level} range $${min}–$${max} (heuristic, per person)`,
    optionIndex,
    stopIndex,
    placeId: candidate.placeId,
  });
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
    departureTime: leg.mode === "transit" ? (leg.departureTime ?? null) : null,
  });
}

function withBudget<T>(promise: Promise<T>, budgetMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), budgetMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
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
        message: `Travel mode "${leg.mode}" is not supported; v1 allows walk, transit, and bicycle`,
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

function readBooleanField(
  value: unknown,
  key: string
): { ok: true; value: boolean | undefined } | { ok: false } {
  if (value === null || typeof value !== "object" || !(key in value)) {
    return { ok: true, value: undefined };
  }
  const field = (value as Record<string, unknown>)[key];
  if (typeof field === "boolean") {
    return { ok: true, value: field };
  }
  return { ok: false };
}

function readParsedBoolean(value: object, key: string): boolean | undefined {
  if (!(key in value)) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "boolean" ? field : undefined;
}

function parseKnownSchema<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  optionalKeys: string[]
): z.ZodSafeParseResult<T> {
  const direct = schema.safeParse(raw);
  if (direct.success) {
    return direct;
  }
  // This branch's schemas are `.strict()` and do not yet know `singleStop`.
  // #8 adds the field; the first parse then succeeds and those keys stay.
  let current = raw;
  for (const key of optionalKeys) {
    const stripped = omitKey(current, key);
    if (stripped === current) {
      continue;
    }
    const retry = schema.safeParse(stripped);
    if (retry.success) {
      return retry;
    }
    current = stripped;
  }
  return direct;
}

function parseSharedItinerary(raw: unknown): z.ZodSafeParseResult<z.infer<typeof itinerarySchema>> {
  return parseKnownSchema(itinerarySchema, raw, ["singleStop"]);
}

function isTravelModeIssue(issue: z.core.$ZodIssue): boolean {
  return issue.path[issue.path.length - 1] === "mode";
}

function omitKey(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  if (!(key in value)) {
    return value;
  }
  const copy = { ...(value as Record<string, unknown>) };
  delete copy[key];
  return copy;
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
