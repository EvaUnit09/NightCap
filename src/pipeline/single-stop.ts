/**
 * Pure singleStop checks for plan/repair staging and for PR #7's validator.
 * Never trust `singleStop` from model output — copy it from the parsed intent.
 */

export function singleStopMatchesIntent(
  modelItinerary: unknown,
  intentSingleStop: boolean
): boolean {
  if (modelItinerary === null || typeof modelItinerary !== "object") {
    return false;
  }
  if (!Object.hasOwn(modelItinerary, "singleStop")) {
    return true;
  }
  return Reflect.get(modelItinerary, "singleStop") === intentSingleStop;
}

export function stampSingleStopFromIntent<T extends object>(
  itinerary: T,
  intentSingleStop: boolean
): T & { singleStop: boolean } {
  return { ...itinerary, singleStop: intentSingleStop };
}
