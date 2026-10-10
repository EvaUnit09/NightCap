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
});

describe("stampSingleStopFromIntent", () => {
  it("copies singleStop from the intent and overwrites the model value", () => {
    const stamped = stampSingleStopFromIntent({ singleStop: true, theme: "x" }, false);
    assert.equal(stamped.singleStop, false);
    assert.equal(stamped.theme, "x");
  });
});
