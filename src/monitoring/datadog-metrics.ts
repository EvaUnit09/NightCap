import "server-only";

import { getRateLimitDailySpendUsd } from "../models/config";
import { dailySpendFraction } from "./spend-fraction";
import type { RequestOutput } from "./trace-types";

export const SPEND_FRACTION_METRIC = "nightcap.spend.daily_fraction";
export const REQUEST_ERROR_METRIC = "nightcap.request.error";
export const REQUEST_TOTAL_METRIC = "nightcap.request.total";
export const METRICS_DISABLED_WARNING =
  "[monitoring] Datadog metrics disabled: DD_API_KEY is unset, so no series were submitted";

const SERVICE_TAG = "service:nightcap";

export type RequestMetricSource = "app" | "eval";

export interface MetricSeries {
  readonly metric: string;
  readonly type: "gauge" | "count";
  readonly points: readonly (readonly [number, number])[];
  readonly tags: readonly string[];
}

export interface DatadogSeriesBody {
  readonly series: readonly MetricSeries[];
}

export type SeriesSubmitResult =
  | { readonly mode: "submitted"; readonly status: number }
  | { readonly mode: "skipped"; readonly warning: string };

export interface SeriesSubmitDeps {
  readonly env?: Record<string, string | undefined>;
  readonly fetch?: typeof fetch;
}

type SeriesPoster = (body: DatadogSeriesBody) => Promise<SeriesSubmitResult>;

let poster: SeriesPoster | null = null;
let warnedMissingKey = false;
let loggedSpendSample = false;

export function setSeriesPosterForTests(next: SeriesPoster | null): void {
  poster = next;
}

export function resetDatadogMetricsForTests(): void {
  poster = null;
  warnedMissingKey = false;
  loggedSpendSample = false;
}

export function readMetricsApiKey(env: Record<string, string | undefined>): string | undefined {
  const raw = env.DD_API_KEY;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function datadogApiOrigin(site: string | undefined): string {
  const host = site === undefined || site.trim() === "" ? "datadoghq.com" : site.trim();
  if (!/^[a-z0-9.-]+$/.test(host)) {
    throw new Error("DD_SITE must be a hostname");
  }
  return `https://api.${host}`;
}

export function requestFailed(input: {
  readonly thrown: boolean;
  readonly output?: RequestOutput;
}): boolean {
  if (input.thrown) return true;
  const output = input.output;
  if (output === undefined) return false;
  switch (output.status) {
    case "failed":
      return true;
    case "completed":
      return false;
    default: {
      const exhaustive: never = output;
      return exhaustive;
    }
  }
}

export function spendSeries(micros: number, capUsd: number, nowSec: number): DatadogSeriesBody {
  return {
    series: [
      {
        metric: SPEND_FRACTION_METRIC,
        type: "gauge",
        points: [[nowSec, dailySpendFraction(micros, capUsd)]],
        tags: [SERVICE_TAG],
      },
    ],
  };
}

export function requestSeries(
  failed: boolean,
  source: RequestMetricSource,
  nowSec: number,
): DatadogSeriesBody {
  const tags = [SERVICE_TAG, `source:${source}`];
  return {
    series: [
      {
        metric: REQUEST_ERROR_METRIC,
        type: "count",
        points: [[nowSec, failed ? 1 : 0]],
        tags,
      },
      {
        metric: REQUEST_TOTAL_METRIC,
        type: "count",
        points: [[nowSec, 1]],
        tags,
      },
    ],
  };
}

export async function submitSeries(
  body: DatadogSeriesBody,
  deps: SeriesSubmitDeps = {},
): Promise<SeriesSubmitResult> {
  if (poster) return poster(body);
  const env = deps.env ?? process.env;
  const key = readMetricsApiKey(env);
  if (key === undefined) {
    warnMissingKey();
    return { mode: "skipped", warning: METRICS_DISABLED_WARNING };
  }
  if (deps.fetch === undefined && process.env.NODE_TEST_CONTEXT !== undefined) {
    // Test runs set a Datadog key and only redirect https.request. Global fetch
    // would leave that process for the real intake host.
    return { mode: "skipped", warning: "[monitoring] Datadog metrics skipped during tests" };
  }
  const fetchImpl = deps.fetch ?? fetch;
  const response = await fetchImpl(`${datadogApiOrigin(env.DD_SITE)}/api/v1/series`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(2_000),
    headers: {
      "content-type": "application/json",
      "DD-API-KEY": key,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Datadog series HTTP ${response.status}`);
  }
  await response.arrayBuffer();
  return { mode: "submitted", status: response.status };
}

export function publishDailySpend(micros: number): void {
  try {
    if (metricsPaused()) return;
    if (!metricsActive()) {
      warnMissingKey();
      return;
    }
    const capUsd = getRateLimitDailySpendUsd();
    const body = spendSeries(micros, capUsd, unixSeconds());
    logSpendSampleTiming();
    schedule(body, "spend");
  } catch (error) {
    console.warn(`[monitoring] spend metric skipped: ${errorName(error)}`);
  }
}

export function publishRequestOutcome(input: {
  readonly thrown: boolean;
  readonly output?: RequestOutput;
  readonly source: RequestMetricSource;
}): void {
  try {
    if (metricsPaused()) return;
    if (!metricsActive()) {
      warnMissingKey();
      return;
    }
    schedule(requestSeries(requestFailed(input), input.source, unixSeconds()), "request");
  } catch (error) {
    console.warn(`[monitoring] request metric skipped: ${errorName(error)}`);
  }
}

function metricsActive(): boolean {
  return poster !== null || readMetricsApiKey(process.env) !== undefined;
}

function metricsPaused(): boolean {
  const phase = process.env.NEXT_PHASE;
  if (phase !== undefined && (phase.includes("build") || phase.includes("export"))) return true;
  if (process.env.npm_lifecycle_event === "build") return true;
  return process.env.NEXT_RUNTIME === "edge";
}

function warnMissingKey(): void {
  if (warnedMissingKey) return;
  warnedMissingKey = true;
  console.warn(METRICS_DISABLED_WARNING);
}

function logSpendSampleTiming(): void {
  if (process.env.NIGHTCAP_METRIC_TIMING !== "1" || loggedSpendSample) return;
  loggedSpendSample = true;
  console.log(`[monitoring] spend metric sample at ${Math.round(process.uptime() * 1000)}ms`);
}

function schedule(body: DatadogSeriesBody, label: string): void {
  void submitSeries(body).catch((error: unknown) => {
    console.warn(`[monitoring] ${label} metric skipped: ${errorName(error)}`);
  });
}

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z0-9_.:-]{1,64}$/.test(error.name) ? error.name : "Error";
}
