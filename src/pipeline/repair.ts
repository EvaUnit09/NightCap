import type { ItineraryOption } from "../validation/itinerary";
import type { ValidationError, ValidationErrorCode } from "../validation/validation-error";

/** Codes no model edit can fix. The repair prompt says to leave them to the pipeline. */
const UNREPAIRABLE_CODES: ReadonlySet<ValidationErrorCode> = new Set(["travel_service_unavailable"]);

/**
 * Validator findings per option. A finding with no `optionIndex` (the
 * validator stops early on a schema failure across options) is charged to
 * every option that changed this round: one of them caused it.
 */
export function errorsByOption(
  errors: readonly ValidationError[],
  changed: readonly number[],
): ReadonlyMap<number, readonly ValidationError[]> {
  const unattributed = errors.filter((error) => error.optionIndex === undefined);
  return new Map(
    changed.map((optionIndex) => [
      optionIndex,
      [...errors.filter((error) => error.optionIndex === optionIndex), ...unattributed],
    ]),
  );
}

export function isRepairable(errors: readonly ValidationError[]): boolean {
  return errors.some((error) => !UNREPAIRABLE_CODES.has(error.code));
}

/** Stop indexes the validator pointed at, or null when a finding covers the whole option. */
function failingStops(errors: readonly ValidationError[]): ReadonlySet<number> | null {
  if (errors.some((error) => error.stopIndex === undefined)) {
    return null;
  }
  return new Set(errors.flatMap((error) => (error.stopIndex === undefined ? [] : [error.stopIndex])));
}

/**
 * Keep the model's edit only where the validator found a problem (build
 * step 15: repair fixes only the failing stops). A passing stop keeps its
 * venue, times, cost, and why; the stop before a failing one may change only
 * its travel to the next stop, since that leg now ends somewhere new. When a
 * finding covers the whole option (over budget, format) or the stop count
 * changed, the model's option is taken as is and the next validation judges it.
 */
export function mergeRepair(
  original: ItineraryOption,
  repaired: ItineraryOption,
  errors: readonly ValidationError[],
): ItineraryOption {
  const failing = failingStops(errors);
  if (failing === null || repaired.stops.length !== original.stops.length) {
    return repaired;
  }
  return {
    ...original,
    stops: original.stops.map((stop, index) => {
      const edit = repaired.stops[index];
      if (failing.has(index)) {
        return edit;
      }
      if (failing.has(index + 1)) {
        return { ...stop, travelToNext: edit.travelToNext };
      }
      return stop;
    }),
  };
}
