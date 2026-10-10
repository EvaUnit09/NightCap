/**
 * Eval boundaries. The runner is a later action.
 * Format compliance scores model output against these schemas.
 *
 * Travel minutes in eval and in unit tests use a fake or recorded
 * calculator. Live Google Routes is opt-in only via ENABLE_LIVE_ROUTES.
 */
export {
  candidateSchema,
  intentSchema,
  itinerarySchema,
  parseCandidate,
  parseIntent,
  parseItinerary,
  parseToolInput,
  parseValidationError,
  toolInputSchema,
  validationErrorSchema,
} from "../src/validation";
