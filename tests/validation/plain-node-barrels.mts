/**
 * Spawned without tests/setup.mjs. Fails if a barrel or the validator
 * subpath pulls in server-only.
 */
import * as evaluation from "../../evaluation/index";
import * as validation from "../../src/validation/index";
import * as validator from "../../src/validation/validator";

if ("validateItinerary" in validation) {
  throw new Error("src/validation must not re-export validateItinerary");
}
if (!validation.intentSchema || !validation.itinerarySchema) {
  throw new Error("src/validation is missing schema exports");
}
if (!evaluation.intentSchema || !evaluation.itinerarySchema) {
  throw new Error("evaluation/index.ts is missing schema exports");
}
if (typeof validator.validateItinerary !== "function") {
  throw new Error("src/validation/validator missing validateItinerary");
}
console.log("ok");
