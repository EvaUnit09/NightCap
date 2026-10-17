import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { composerSubmitUi } from "../../app/_home/composer-submit";

describe("composerSubmitUi", () => {
  it("leaves a nonempty request ready to send while idle", () => {
    assert.deepEqual(composerSubmitUi(false, true), {
      disabled: false,
      label: "Plan our night",
      status: null,
    });
  });

  it("disables an empty request while idle", () => {
    assert.deepEqual(composerSubmitUi(false, false), {
      disabled: true,
      label: "Plan our night",
      status: null,
    });
  });

  it("blocks a nonempty request and says it is planning while streaming", () => {
    assert.deepEqual(composerSubmitUi(true, true), {
      disabled: true,
      label: "Planning…",
      status: "Planning your night",
    });
  });

  it("blocks an empty request and says it is planning while streaming", () => {
    assert.deepEqual(composerSubmitUi(true, false), {
      disabled: true,
      label: "Planning…",
      status: "Planning your night",
    });
  });
});
