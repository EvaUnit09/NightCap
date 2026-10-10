/**
 * Pure singleStop checks for plan/repair staging and for PR #7's validator.
 * Never trust `singleStop` from model output — copy it from the parsed intent.
 * No server-only import and no config reads.
 */

/** Own boolean `singleStop`, or `null` when the value is not a usable object/flag. */
function singleStopFlag(value: unknown): boolean | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  if (!Object.hasOwn(value, "singleStop")) {
    return false;
  }
  const flag = (value as { singleStop: unknown }).singleStop;
  return typeof flag === "boolean" ? flag : null;
}

export function singleStopMatchesIntent(itinerary: unknown, intent: unknown): boolean {
  const itineraryFlag = singleStopFlag(itinerary);
  const intentFlag = typeof intent === "boolean" ? intent : singleStopFlag(intent);
  if (itineraryFlag === null || intentFlag === null) {
    return false;
  }
  return itineraryFlag === intentFlag;
}

export function stampSingleStopFromIntent<T extends object>(
  itinerary: T,
  intentSingleStop: boolean
): T & { singleStop: boolean } {
  return { ...itinerary, singleStop: intentSingleStop };
}
