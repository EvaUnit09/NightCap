import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as validation from "../../src/validation";

describe("validation public exports for #7", () => {
  it("exports itinerary, intent, stop-count, and singleStop helpers", () => {
    assert.equal(typeof validation.itinerarySchema.parse, "function");
    assert.equal(typeof validation.itineraryOptionSchemaFor, "function");
    assert.equal(typeof validation.itinerarySchemaFor, "function");
    assert.equal(typeof validation.allowedShapes, "function");
    assert.equal(typeof validation.toolInputSchemaFor, "function");
    assert.equal(typeof validation.intentSchema.parse, "function");
    assert.equal(validation.STOPS_MIN, 2);
    assert.equal(validation.STOPS_MIN_SINGLE, 1);
    assert.equal(validation.STOPS_MAX, 4);
    assert.equal(validation.MAX_TRAVEL_LEGS_PER_REQUEST_DEFAULT, 4);
    assert.equal(typeof validation.singleStopMatchesIntent, "function");
    assert.equal(typeof validation.stampSingleStopFromIntent, "function");
  });
});
