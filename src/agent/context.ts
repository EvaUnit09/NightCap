import type { Retrieval } from "../retrieval";
import type { SearchVenuesInput } from "../retrieval/query";
import type { Candidate } from "../validation/candidate";
import type { Intent } from "../validation/intent";
import type { Itinerary } from "../validation/itinerary";
import type { ValidationError } from "../validation/validation-error";
import type { ValidatorInput, ValidatorOptions } from "../validation/validator";

/**
 * Injected deps for one tool call. The turn loop owns itinerary mutation;
 * tools return the next itinerary in their content when they edit it.
 */
export interface AgentToolContext {
  readonly itinerary: Itinerary;
  readonly intent: Intent;
  /** Place ids from `search_venues` results in this turn (replace_stop gate). */
  readonly allowedPlaceIds: ReadonlySet<string>;
  /** Candidate facts for validation and for filling a replaced stop's name. */
  readonly candidates: readonly Candidate[];
  readonly retrieve: (input: SearchVenuesInput, signal?: AbortSignal) => Promise<Retrieval>;
  readonly validate: (
    input: ValidatorInput,
    options?: ValidatorOptions,
  ) => Promise<readonly ValidationError[]>;
  readonly signal?: AbortSignal;
}
