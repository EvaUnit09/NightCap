import type { Candidate } from "./candidate";
import { candidateSchema } from "./candidate";
import type { Intent } from "./intent";
import { intentSchema } from "./intent";
import type { Itinerary } from "./itinerary";
import { itinerarySchema } from "./itinerary";
import { effectiveStopBounds, readItineraryBounds } from "./schema-bounds";
import type { TravelCalculator, TravelLeg } from "./travel";
import {
  validationErrorSchema,
  type ValidationError,
} from "./validation-error";

/** Couple-night USD per stop. Overridable via `ValidatorOptions.priceRanges`. */
export const DEFAULT_PRICE_RANGES = {
  PRICE_LEVEL_FREE: [0, 0],
  PRICE_LEVEL_INEXPENSIVE: [0, 40],
  PRICE_LEVEL_MODERATE: [20, 120],
  PRICE_LEVEL_EXPENSIVE: [80, 250],
  PRICE_LEVEL_VERY_EXPENSIVE: [150, 1000],
} as const satisfies Record<string, readonly [number, number]>;

export type PriceLevelKey = keyof typeof DEFAULT_PRICE_RANGES;
export type PriceRanges = Partial<Record<PriceLevelKey, readonly [number, number]>>;

export interface ValidatorInput {
  intent: unknown;
  candidates: unknown;
  itinerary: unknown;
}

export interface ValidatorOptions {
  /** Max travel minutes between stops. Default 25. */
  travelCapMinutes?: number;
  /**
   * Travel calculator. No production default.
   * Omit it (or return null/NaN/Infinity / throw) and every hop fails closed.
   */
  travelCalculator?: TravelCalculator;
  /** |claimed − computed| above this emits travel_too_long. Default 5. */
  travelToleranceMinutes?: number;
  /** Inclusive USD ranges per PRICE_LEVEL_*. UNSPECIFIED skips the check. */
  priceRanges?: PriceRanges;
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
}

/**
 * Deterministic itinerary validator.
 *
 * Pure: no `server-only`, no config import, no network. Thresholds and the
 * travel calculator are parameters. A sync or async calculator return is allowed.
 *
 * Checks: invented venue, operational, open in America/New_York, name match,
 * budget (every stop's cost), price-level plausibility, travel
 * max(claimed, computed) ≤ cap, claimed-vs-computed tolerance.
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
        code: "not_found",
        message: `Invalid intent format: ${intentParse.error.message}`,
      }),
    ];
  }

  const itineraryParse = itinerarySchema.safeParse(input.itinerary);
  if (!itineraryParse.success) {
    return [
      emitError({
        code: "not_found",
        message: `Invalid itinerary format: ${itineraryParse.error.message}`,
      }),
    ];
  }

  const intent: Intent = intentParse.data;
  const itinerary: Itinerary = itineraryParse.data;
  const planBounds = readItineraryBounds();
  const stopBounds = effectiveStopBounds(intent);
  const candidates = parseCandidates(input.candidates);
  const travelCapMinutes = options.travelCapMinutes ?? 25;
  const travelToleranceMinutes = options.travelToleranceMinutes ?? 5;
  const priceRanges = { ...DEFAULT_PRICE_RANGES, ...options.priceRanges };

  const candidateMap = new Map(
    candidates.map((candidate) => [candidate.placeId, candidate])
  );
  const errors: ValidationError[] = [];
  const pendingTravel: PendingTravel[] = [];

  if (
    itinerary.options.length < planBounds.options.min ||
    itinerary.options.length > planBounds.options.max
  ) {
    errors.push(
      emitError({
        code: "not_found",
        message: `Itinerary must have ${planBounds.options.min}–${planBounds.options.max} options`,
      })
    );
  }

  for (const [optionIndex, option] of itinerary.options.entries()) {
    if (
      option.stops.length < stopBounds.min ||
      option.stops.length > stopBounds.max
    ) {
      errors.push(
        emitError({
          code: "not_found",
          message: `Option ${optionIndex + 1} must have ${stopBounds.min}–${stopBounds.max} stops`,
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
        if (stop.name !== candidate.name) {
          errors.push(
            emitError({
              code: "not_found",
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

  const computed = await computeTravel(options.travelCalculator, pendingTravel);
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
    code: "over_budget",
    message: `Claimed $${claimedUsd} is outside ${level} range $${min}–$${max}`,
    optionIndex,
    stopIndex,
    placeId: candidate.placeId,
  });
}

async function computeTravel(
  calculator: TravelCalculator | undefined,
  pending: PendingTravel[]
): Promise<Array<number | null>> {
  if (pending.length === 0) {
    return [];
  }
  if (!calculator) {
    return pending.map(() => null);
  }
  const legs: TravelLeg[] = pending.map((leg) => ({
    from: leg.from,
    to: leg.to,
    mode: leg.mode,
  }));
  try {
    const result = await calculator.calculateMinutes(legs);
    if (!Array.isArray(result) || result.length !== pending.length) {
      return pending.map(() => null);
    }
    return [...result];
  } catch {
    return pending.map(() => null);
  }
}

function applyTravelRules(
  errors: ValidationError[],
  leg: PendingTravel,
  computed: number | null,
  travelCapMinutes: number,
  travelToleranceMinutes: number
): void {
  if (leg.from === null || leg.to === null) {
    errors.push(
      emitError({
        code: "travel_too_long",
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
        code: "travel_too_long",
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
        code: "travel_too_long",
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
