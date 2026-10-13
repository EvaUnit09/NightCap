import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runAgentTool, runValidateItinerary } from "../../src/agent";
import type { ValidationError } from "../../src/validation/validation-error";
import { baseContext, sampleItinerary } from "./fixtures";

describe("validate_itinerary", () => {
  it("reports valid when the injected validator returns no errors", async () => {
    const itinerary = sampleItinerary();
    const result = await runValidateItinerary(
      { tool: "validate_itinerary", itinerary },
      baseContext({ validate: async () => [] }),
    );
    assert.equal(result.is_error, false);
    if (result.is_error) return;
    const content = result.content as { valid: boolean; errors: readonly ValidationError[] };
    assert.equal(content.valid, true);
    assert.equal(content.errors.length, 0);
  });

  it("returns validator errors without is_error", async () => {
    const itinerary = sampleItinerary();
    const errors: ValidationError[] = [
      { code: "over_budget", message: "too expensive", optionIndex: 0 },
    ];
    const result = await runValidateItinerary(
      { tool: "validate_itinerary", itinerary },
      baseContext({ validate: async () => errors }),
    );
    assert.equal(result.is_error, false);
    if (result.is_error) return;
    const content = result.content as { valid: boolean; errors: readonly ValidationError[] };
    assert.equal(content.valid, false);
    assert.equal(content.errors[0]?.code, "over_budget");
  });

  it("returns is_error when the validator throws", async () => {
    const itinerary = sampleItinerary();
    const result = await runValidateItinerary(
      { tool: "validate_itinerary", itinerary },
      baseContext({
        validate: async () => {
          throw new Error("boom");
        },
      }),
    );
    assert.equal(result.is_error, true);
    if (!result.is_error) return;
    assert.equal(result.error.code, "validate_failed");
  });

  it("rejects unknown tool input at the shared Zod boundary via runAgentTool", async () => {
    const result = await runAgentTool(
      { tool: "replace_stop", optionIndex: 0, stopIndex: 0, placeId: "" },
      baseContext(),
    );
    assert.equal(result.is_error, true);
    if (!result.is_error) return;
    assert.equal(result.error.code, "invalid_tool_input");
  });
});
