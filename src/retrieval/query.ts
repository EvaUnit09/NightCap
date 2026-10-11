import type { Candidate } from "../validation/candidate";
import type { StopTypes } from "./stop-types";

export type PriceLevel = NonNullable<Candidate["priceLevel"]>;

/** ISO datetimes with an offset, already validated upstream. */
export interface TimeSlot {
  readonly start: string;
  readonly end: string;
}

/**
 * The one retrieval question. Both callers reduce to it, so nothing below
 * retrieve.ts knows whether an Intent or a tool call asked.
 */
export interface VenueQuery {
  /** Free text. Sent to Google inside textQuery; never put on a span. */
  readonly area: string;
  readonly stopTypes: StopTypes;
  readonly slot: TimeSlot;
  /** null and PRICE_LEVEL_UNSPECIFIED always pass, as in the validator. */
  readonly acceptedPriceLevels: ReadonlySet<PriceLevel>;
  /** Lowercased, trimmed, deduped. Empty for agent tool calls. */
  readonly vibeTags: readonly string[];
}
