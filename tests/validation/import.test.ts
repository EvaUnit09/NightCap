import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  STOPS_MAX,
  STOPS_MIN,
  STOPS_MIN_SINGLE,
} from "../../src/validation/bounds";

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

  it("imports src/validation, evaluation/index.ts, and the validator subpath under plain node", () => {
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

  it("exposes #8 stop-count constants from src/validation/bounds", () => {
    assert.equal(STOPS_MIN, 2);
    assert.equal(STOPS_MIN_SINGLE, 1);
    assert.equal(STOPS_MAX, 4);
  });
});
