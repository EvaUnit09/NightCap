/**
 * Eval boundaries. `npm run eval` (cli.ts) runs the pipeline over the
 * frozen v1 set; record.ts is the per-case data shape and score.ts the
 * pure metrics. Format compliance scores model output against these schemas.
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
