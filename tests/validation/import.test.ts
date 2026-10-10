import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  effectiveStopBounds,
  readItineraryBounds,
} from "../../src/validation/schema-bounds";

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

  it("imports src/validation and evaluation/index.ts under plain node", () => {
    const script = fileURLToPath(
      new URL("./plain-node-barrels.mts", import.meta.url)
    );
    const result = spawnSync(process.execPath, ["--import", "tsx", script], {
      encoding: "utf8",
      env: { ...process.env },
    });
    assert.equal(
      result.status,
      0,
      `plain-node barrel import failed:\n${result.stderr}\n${result.stdout}`
    );
    assert.match(result.stdout, /ok/);
  });

  it("reads option and stop bounds from the itinerary schemas", () => {
    const bounds = readItineraryBounds();
    assert.ok(Number.isFinite(bounds.options.min));
    assert.ok(Number.isFinite(bounds.options.max));
    assert.ok(Number.isFinite(bounds.stops.min));
    assert.ok(Number.isFinite(bounds.stops.max));
    assert.ok(bounds.options.min <= bounds.options.max);
    assert.ok(bounds.stops.min <= bounds.stops.max);
  });

  it("lowers the stop minimum to 1 when intent.singleStop is true", () => {
    const withFlag = effectiveStopBounds({ singleStop: true });
    const without = effectiveStopBounds({});
    assert.equal(withFlag.min, 1);
    assert.ok(without.min >= 1);
    assert.equal(withFlag.max, without.max);
  });
});
