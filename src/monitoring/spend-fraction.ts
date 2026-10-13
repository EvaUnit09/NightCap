import "server-only";

import { usdToMicros } from "./spend-cap";

export const SPEND_ALERT_FRACTION = 0.8;

export const ERROR_RATE_ALERT = 0.1;

export type MonitorState = "alert" | "ok";

export function eightyPercentMicros(capUsd: number): number {
  return Math.round(positiveCapMicros(capUsd) * SPEND_ALERT_FRACTION);
}

export function dailySpendFraction(micros: number, capUsd: number): number {
  const capMicros = positiveCapMicros(capUsd);
  if (!Number.isSafeInteger(micros) || micros < 0) {
    throw new Error("daily spend micros must be a non-negative integer");
  }
  return micros / capMicros;
}

export function requestErrorRate(errors: number, total: number): number {
  if (
    !Number.isSafeInteger(errors) ||
    !Number.isSafeInteger(total) ||
    errors < 0 ||
    total <= 0 ||
    errors > total
  ) {
    throw new Error("request error rate needs a positive total and an error count inside that total");
  }
  return errors / total;
}

export function monitorState(value: number, threshold: number): MonitorState {
  if (!Number.isFinite(value) || !Number.isFinite(threshold)) {
    throw new Error("monitor comparison needs finite numbers");
  }
  return value >= threshold ? "alert" : "ok";
}

function positiveCapMicros(capUsd: number): number {
  const capMicros = usdToMicros(capUsd);
  if (!Number.isSafeInteger(capMicros) || capMicros <= 0) {
    throw new Error("daily spend cap must be a positive USD amount");
  }
  return capMicros;
}
