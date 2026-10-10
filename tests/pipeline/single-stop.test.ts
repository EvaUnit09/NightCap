import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  singleStopMatchesIntent,
  stampSingleStopFromIntent,
} from "../../src/validation";

describe("singleStopMatchesIntent", () => {
  it("does not trust a model singleStop that differs from the intent", () => {
    assert.equal(singleStopMatchesIntent({ singleStop: true }, false), false);
    assert.equal(singleStopMatchesIntent({ singleStop: false }, true), false);
  });

  it("treats a missing singleStop key as false", () => {
    assert.equal(singleStopMatchesIntent({}, true), false);
    assert.equal(singleStopMatchesIntent({}, { singleStop: true }), false);
    assert.equal(singleStopMatchesIntent({}, false), true);
    assert.equal(singleStopMatchesIntent({ options: [] }, { singleStop: false }), true);
    assert.equal(singleStopMatchesIntent({}, {}), true);
  });

  it("accepts a model singleStop only when it already matches the intent", () => {
    assert.equal(singleStopMatchesIntent({ singleStop: true }, true), true);
    assert.equal(singleStopMatchesIntent({ singleStop: false }, false), true);
  });

  it("rejects a non-boolean model singleStop even if it looks true", () => {
    assert.equal(singleStopMatchesIntent({ singleStop: "true" }, true), false);
  });

  it("returns false for null and non-objects and never reads inherited singleStop", () => {
    assert.equal(singleStopMatchesIntent(null, false), true);
    assert.equal(singleStopMatchesIntent(null, true), false);
    assert.equal(singleStopMatchesIntent(undefined, false), true);
    assert.equal(singleStopMatchesIntent(42, false), true);
    assert.equal(singleStopMatchesIntent("nope", true), false);

    const inherited = Object.create({ singleStop: true });
    assert.equal(Object.hasOwn(inherited, "singleStop"), false);
    assert.equal(singleStopMatchesIntent(inherited, true), false);
    assert.equal(singleStopMatchesIntent(inherited, false), true);

    const inheritedIntent = Object.create({ singleStop: true });
    assert.equal(singleStopMatchesIntent({ singleStop: false }, inheritedIntent), true);
  });
});

describe("stampSingleStopFromIntent", () => {
  it("copies singleStop from the intent and overwrites the model value", () => {
    const stamped = stampSingleStopFromIntent({ singleStop: true, theme: "x" }, false);
    assert.equal(stamped.singleStop, false);
    assert.equal(stamped.theme, "x");
  });
});
