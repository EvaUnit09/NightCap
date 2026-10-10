import "server-only";

import { getTravelCapMinutes } from "../models/config";
import type { Candidate } from "./candidate";
import type { Intent } from "./intent";
import type { Itinerary } from "./itinerary";
import { defaultTravelCalculator, type TravelCalculator } from "./travel";
import type { ValidationError } from "./validation-error";

/**
 * Validate itinerary input: intent + candidates + itinerary.
 */
export interface ValidatorInput {
  intent: Intent;
  candidates: Candidate[];
  itinerary: Itinerary;
}

/**
 * Deterministic itinerary validator.
 * Checks:
 * - Every venue exists in candidates (no invented venues)
 * - Every venue is OPERATIONAL
 * - Every venue is open during its stop slot
 * - Total estimated cost per option is within budget
 * - Travel time between stops is ≤ TRAVEL_CAP_MINUTES
 *
 * Pure function (except for config read).
 * No network calls, no side effects.
 * Callable from pipeline, repair loop, agent tool, and eval runner.
 *
 * @param input - Intent, candidates, and itinerary to validate
 * @param travelCalculator - Optional custom travel calculator (defaults to Haversine)
 * @returns Array of validation errors (empty if valid)
 */
export async function validateItinerary(
  input: ValidatorInput,
  travelCalculator: TravelCalculator = defaultTravelCalculator
): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];
  const { intent, candidates, itinerary } = input;
  const travelCapMinutes = getTravelCapMinutes();

  const candidateMap = new Map(
    candidates.map((candidate) => [candidate.placeId, candidate])
  );

  for (const [optionIndex, option] of itinerary.options.entries()) {
    let totalCostUsd = 0;

    for (const [stopIndex, stop] of option.stops.entries()) {
      const candidate = candidateMap.get(stop.placeId);

      if (!candidate) {
        errors.push({
          code: "invented_venue",
          message: `Place ID ${stop.placeId} is not in the candidate list`,
          optionIndex,
          stopIndex,
          placeId: stop.placeId,
        });
        continue;
      }

      if (candidate.businessStatus !== "OPERATIONAL") {
        errors.push({
          code: "not_operational",
          message: `${candidate.name} is ${candidate.businessStatus}`,
          optionIndex,
          stopIndex,
          placeId: stop.placeId,
        });
        continue;
      }

      if (!isOpenDuringSlot(candidate, stop.start, stop.end)) {
        errors.push({
          code: "closed",
          message: `${candidate.name} is closed during ${stop.start} to ${stop.end}`,
          optionIndex,
          stopIndex,
          placeId: stop.placeId,
        });
      }

      totalCostUsd += stop.estimatedCostUsd;

      if (stop.travelToNext !== null) {
        const nextStop = option.stops[stopIndex + 1];
        if (nextStop) {
          const nextCandidate = candidateMap.get(nextStop.placeId);
          if (nextCandidate) {
            const travelMinutes = await travelCalculator.calculateMinutes(
              candidate.location,
              nextCandidate.location,
              stop.travelToNext.mode
            );

            if (
              travelMinutes !== null &&
              travelMinutes > travelCapMinutes
            ) {
              errors.push({
                code: "travel_too_long",
                message: `Travel from ${candidate.name} to ${nextCandidate.name} is ${travelMinutes} min (cap: ${travelCapMinutes} min)`,
                optionIndex,
                stopIndex,
                placeId: stop.placeId,
              });
            }
          }
        }
      }
    }

    if (totalCostUsd > intent.budgetUsd) {
      errors.push({
        code: "over_budget",
        message: `Option ${optionIndex + 1} total cost $${totalCostUsd} exceeds budget $${intent.budgetUsd}`,
        optionIndex,
      });
    }
  }

  return errors;
}

/**
 * Check if a venue is open during a time slot.
 * Handles:
 * - 24/7 venues (no closing time)
 * - FUTURE_OPENING (not yet open, treated as closed)
 * - Slots crossing midnight
 * - Day-of-week boundaries
 *
 * @param candidate - Venue with opening hours
 * @param slotStart - ISO 8601 datetime for slot start
 * @param slotEnd - ISO 8601 datetime for slot end
 * @returns True if venue is open for the entire slot
 */
function isOpenDuringSlot(
  candidate: Candidate,
  slotStart: string,
  slotEnd: string
): boolean {
  if (candidate.businessStatus === "FUTURE_OPENING") {
    return false;
  }

  const { openingHours } = candidate;

  if (openingHours.length === 0) {
    return false;
  }

  const is24x7 = openingHours.some((period) => period.close === undefined);
  if (is24x7) {
    return true;
  }

  const slotStartTime = parseISODateTime(slotStart);
  const slotEndTime = parseISODateTime(slotEnd);

  if (slotStartTime.day === slotEndTime.day) {
    return checkOpenOnDay(
      openingHours,
      slotStartTime.day,
      slotStartTime.minute,
      slotEndTime.minute
    );
  }

  const nextDay = (slotStartTime.day + 1) % 7;
  if (slotEndTime.day === nextDay) {
    const openUntilMidnight = checkOpenOnDay(
      openingHours,
      slotStartTime.day,
      slotStartTime.minute,
      24 * 60 - 1
    );
    const openFromMidnight = checkOpenOnDay(
      openingHours,
      slotEndTime.day,
      0,
      slotEndTime.minute
    );
    return openUntilMidnight && openFromMidnight;
  }

  return false;
}

/**
 * Parse ISO 8601 datetime and extract local day and minute of day.
 * The timezone offset in the ISO string represents the local timezone.
 */
function parseISODateTime(isoString: string): { day: number; minute: number } {
  const match = isoString.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!match) {
    throw new Error(`Invalid ISO datetime: ${isoString}`);
  }

  const year = parseInt(match[1]!, 10);
  const month = parseInt(match[2]!, 10) - 1;
  const dayOfMonth = parseInt(match[3]!, 10);
  const hour = parseInt(match[4]!, 10);
  const minute = parseInt(match[5]!, 10);

  const localDate = new Date(year, month, dayOfMonth);
  const day = localDate.getDay();

  return {
    day,
    minute: hour * 60 + minute,
  };
}

/**
 * Check if venue has any period that covers the given time range on a specific day.
 * @param openingHours - Venue's weekly opening periods
 * @param day - Day of week (0 = Sunday)
 * @param startMinute - Start time in minutes from midnight
 * @param endMinute - End time in minutes from midnight
 * @returns True if venue is open for the entire range
 */
function checkOpenOnDay(
  openingHours: Array<{
    open: { day: number; hour: number; minute: number };
    close?: { day: number; hour: number; minute: number };
  }>,
  day: number,
  startMinute: number,
  endMinute: number
): boolean {
  for (const period of openingHours) {
    if (!period.close) {
      return true;
    }

    const openDay = period.open.day;
    const openMinute = period.open.hour * 60 + period.open.minute;
    const closeDay = period.close.day;
    const closeMinute = period.close.hour * 60 + period.close.minute;

    if (openDay === day && closeDay === day) {
      if (startMinute >= openMinute && endMinute <= closeMinute) {
        return true;
      }
    }

    if (openDay === day && closeDay !== day) {
      if (startMinute >= openMinute) {
        return true;
      }
    }

    if (closeDay === day && openDay !== day) {
      const prevDay = (day + 6) % 7;
      if (openDay === prevDay && endMinute <= closeMinute) {
        return true;
      }
    }
  }

  return false;
}
