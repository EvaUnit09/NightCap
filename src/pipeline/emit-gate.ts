import type { ItineraryOption } from "../validation/itinerary";
import type { WorkingOption } from "./lifecycle";

declare const admitted: unique symbol;

/**
 * An option cleared to leave the pipeline (build step 16). The brand can
 * only be applied by `admitOption`, so the result type cannot carry a stop
 * whose place id this request's retrieval did not return.
 */
export type EmittedOption = WorkingOption & { readonly [admitted]: true };

export type AdmitResult =
  | { readonly kind: "admitted"; readonly option: EmittedOption }
  | { readonly kind: "refused"; readonly unknownPlaceIds: readonly string[] };

/** Place ids in `option` that are not candidates of this request. */
export function unknownPlaceIds(option: ItineraryOption, candidateIds: ReadonlySet<string>): readonly string[] {
  return option.stops.map((stop) => stop.placeId).filter((placeId) => !candidateIds.has(placeId));
}

/**
 * The last check before an option is emitted, independent of the validator:
 * every stop's place id must be one of this request's retrieval candidates.
 */
export function admitOption(option: WorkingOption, candidateIds: ReadonlySet<string>): AdmitResult {
  const unknown = unknownPlaceIds(option.option, candidateIds);
  if (unknown.length > 0) {
    return { kind: "refused", unknownPlaceIds: unknown };
  }
  return { kind: "admitted", option: option as EmittedOption };
}
