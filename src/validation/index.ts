import { candidateSchema, type Candidate } from "./candidate";
import { intentSchema, type Intent } from "./intent";
import { itinerarySchema, type Itinerary } from "./itinerary";
import { toolInputSchema, type ToolInput } from "./tool-input";
import { validationErrorSchema, type ValidationError } from "./validation-error";

export {
  businessStatusSchema,
  isoDateTimeSchema,
  placeIdSchema,
  priceLevelSchema,
  stopTypeSchema,
  travelModeSchema,
} from "./common";
export { candidateSchema, type Candidate } from "./candidate";
export {
  INTENT_TAG_MAX,
  STOP_TYPES_MAX,
  STOP_TYPES_MIN,
  STOP_TYPES_MIN_SINGLE,
  intentSchema,
  type Intent,
} from "./intent";
export {
  ITINERARY_OPTIONS_MAX,
  ITINERARY_OPTIONS_MIN,
  STOPS_MAX,
  STOPS_MIN,
  STOPS_MIN_SINGLE,
  itineraryOptionSchema,
  itineraryOptionSchemaFor,
  itinerarySchema,
  type Itinerary,
  type ItineraryOption,
} from "./itinerary";
export { stopSchema, travelToNextSchema, type Stop, type TravelToNext } from "./stop";
export {
  validationErrorCodeSchema,
  validationErrorSchema,
  type ValidationError,
  type ValidationErrorCode,
} from "./validation-error";
export { toolInputSchema, type ToolInput } from "./tool-input";

/** Parse a `parse_intent` payload. */
export function parseIntent(input: unknown): Intent {
  return intentSchema.parse(input);
}

/** Parse one Places candidate. */
export function parseCandidate(input: unknown): Candidate {
  return candidateSchema.parse(input);
}

/** Parse a plan of 2–3 options. */
export function parseItinerary(input: unknown): Itinerary {
  return itinerarySchema.parse(input);
}

/** Parse one validator finding. */
export function parseValidationError(input: unknown): ValidationError {
  return validationErrorSchema.parse(input);
}

/** Parse one refinement-tool input. */
export function parseToolInput(input: unknown): ToolInput {
  return toolInputSchema.parse(input);
}
