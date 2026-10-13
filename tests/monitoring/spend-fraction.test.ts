import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { getRateLimitDailySpendUsd, resetConfig } from "../../src/models/config";
import { usdToMicros } from "../../src/monitoring/spend-cap";
import {
  ERROR_RATE_ALERT,
  SPEND_ALERT_FRACTION,
  dailySpendFraction,
  eightyPercentMicros,
  monitorState,
  requestErrorRate,
} from "../../src/monitoring/spend-fraction";

describe("dailySpendFraction", () => {
  const previous = process.env.RATE_LIMIT_DAILY_SPEND_USD;

  beforeEach(() => {
    process.env.RATE_LIMIT_DAILY_SPEND_USD = "5";
    resetConfig();
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.RATE_LIMIT_DAILY_SPEND_USD;
    else process.env.RATE_LIMIT_DAILY_SPEND_USD = previous;
    resetConfig();
  });

  it("crosses 0.8 exactly at 80% of RATE_LIMIT_DAILY_SPEND_USD", () => {
    const capUsd = getRateLimitDailySpendUsd();
    const micros = eightyPercentMicros(capUsd);

    assert.equal(capUsd, 5);
    assert.equal(usdToMicros(capUsd), 5_000_000);
    assert.equal(micros, 4_000_000);
    assert.equal(dailySpendFraction(micros, capUsd), 0.8);
    assert.equal(monitorState(dailySpendFraction(micros, capUsd), SPEND_ALERT_FRACTION), "alert");
    assert.equal(monitorState(dailySpendFraction(micros - 1, capUsd), SPEND_ALERT_FRACTION), "ok");
  });

  it("treats 1 error in 10 requests as an alert at 0.1 and 0 errors as ok", () => {
    assert.equal(requestErrorRate(1, 10), 0.1);
    assert.equal(monitorState(requestErrorRate(1, 10), ERROR_RATE_ALERT), "alert");
    assert.equal(requestErrorRate(0, 10), 0);
    assert.equal(monitorState(requestErrorRate(0, 10), ERROR_RATE_ALERT), "ok");
  });
});
