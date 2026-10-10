import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("validator importability", () => {
  it("imports from src/validation/validator in plain Node", async () => {
    const mod = await import("../../src/validation/validator");
    assert.equal(typeof mod.validateItinerary, "function");
  });

  it("does not re-export the validator from the schemas index", async () => {
    const schemas = await import("../../src/validation/index");
    assert.equal(
      "validateItinerary" in schemas,
      false,
      "schema barrel must stay client-safe"
    );
    assert.ok(schemas.candidateSchema);
    assert.ok(schemas.intentSchema);
    assert.ok(schemas.validationErrorSchema);
  });

  it("schema index source does not import the validator", () => {
    const source = readFileSync(
      new URL("../../src/validation/index.ts", import.meta.url),
      "utf8"
    );
    assert.equal(source.includes("./validator"), false);
    assert.equal(source.includes("validateItinerary"), false);
  });
});
