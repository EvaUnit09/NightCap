import { errorsByOption } from "../src/pipeline/repair";
import type { Candidate } from "../src/validation/candidate";
import type { Intent } from "../src/validation/intent";
import type { ItineraryOption } from "../src/validation/itinerary";
import type { ValidationError, ValidationErrorCode } from "../src/validation/validation-error";
import type { ValidatorInput } from "../src/validation/validator";
import type { DroppedOption } from "../src/pipeline/lifecycle";

/** The itinerary schema asks for 2 to 3 options, so a lone option cannot be validated (decision #36). */
export const MIN_OPTIONS_TO_VALIDATE = 2;

export interface Judged {
  /** Indexes of options with no validator finding. */
  readonly validIndexes: readonly number[];
  /** One entry per option with findings. */
  readonly dropped: readonly DroppedOption[];
}

function codesFor(errors: readonly ValidationError[]): ValidationErrorCode[] {
  return errors.map((error) => error.code);
}

/**
 * The real validator over a baseline's whole plan, split per option the way
 * the pipeline's repair loop does: a finding with no option index is charged
 * to every option. A baseline has no repair, so a failing option is dropped
 * with reason `unrepairable`. Fewer than two options are not sent: the
 * validator would reject the set as a format error, which says nothing
 * about the options themselves.
 */
export async function judgeOptions(
  validate: (input: ValidatorInput) => Promise<ValidationError[]>,
  intent: Intent,
  candidates: readonly Candidate[],
  options: readonly ItineraryOption[],
): Promise<Judged> {
  if (options.length < MIN_OPTIONS_TO_VALIDATE) {
    return { validIndexes: [], dropped: [] };
  }
  const errors = await validate({
    intent,
    candidates,
    itinerary: { singleStop: intent.singleStop, options },
  });
  const indexes = options.map((_, index) => index);
  const byOption = errorsByOption(errors, indexes);
  return {
    validIndexes: indexes.filter((index) => (byOption.get(index) ?? []).length === 0),
    dropped: indexes.flatMap((index) => {
      const found = byOption.get(index) ?? [];
      return found.length === 0
        ? []
        : [{ optionIndex: index, reason: "unrepairable" as const, repairRounds: 0, lastCodes: codesFor(found) }];
    }),
  };
}
