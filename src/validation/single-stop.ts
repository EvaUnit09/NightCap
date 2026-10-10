/**
 * Pure singleStop checks for plan/repair staging and for PR #7's validator.
 * Never trust `singleStop` from model output — copy it from the parsed intent.
 * No server-only import and no config reads.
 */

function singleStopOf(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  return (Reflect.get(value, "singleStop") as boolean | undefined) ?? false;
}

export function singleStopMatchesIntent(itinerary: unknown, intent: unknown): boolean {
  const intentFlag = typeof intent === "boolean" ? intent : singleStopOf(intent);
  return singleStopOf(itinerary) === intentFlag;
}

export function stampSingleStopFromIntent<T extends object>(
  itinerary: T,
  intentSingleStop: boolean
): T & { singleStop: boolean } {
  return { ...itinerary, singleStop: intentSingleStop };
}
