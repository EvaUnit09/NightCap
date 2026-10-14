import "server-only";

import { getOptionalDdApiKey } from "../models/config";
import type { PipelineFailure } from "../pipeline/lifecycle";
import { createDatadogMetricsSink } from "./datadog-metrics";
import { isSafeTagValue } from "./span-sanitize";
import { dailySpendFraction } from "./spend-cap";

export const METRICS = {
  spendDailyFraction: "nightcap.spend.daily_fraction",
  planRequests: "nightcap.plan.requests",
  planErrors: "nightcap.plan.errors",
} as const;

export const METRICS_OFF_LINE = "[monitoring] Datadog metrics off: DD_API_KEY not set";

export interface MetricSample {
  readonly metric: (typeof METRICS)[keyof typeof METRICS];
  readonly value: number;
  readonly atMs: number;
  readonly tags: readonly string[];
}

/** Counted outcomes only. 400s, 429s, and aborts are not samples. */
export type PlanOutcome =
  | { readonly kind: "completed" }
  | { readonly kind: "failed"; readonly failure: PipelineFailure }
  | { readonly kind: "internal_error" }
  | { readonly kind: "spend_cap_unavailable" };

export interface MetricsSink {
  readonly kind: "noop" | "memory" | "datadog";
  submit(samples: readonly MetricSample[]): Promise<void>;
}

export interface MemoryMetricsSink extends MetricsSink {
  readonly kind: "memory";
  readonly samples: MetricSample[];
}

type Env = Record<string, string | undefined>;

const SERVICE_TAG = "service:nightcap";

let warnedMissingKey = false;

export function resetMetricsForTests(): void {
  warnedMissingKey = false;
}

export function createNoopMetricsSink(): MetricsSink {
  return {
    kind: "noop",
    async submit() {
      return undefined;
    },
  };
}

export function createMemoryMetricsSink(): MemoryMetricsSink {
  const samples: MetricSample[] = [];
  return {
    kind: "memory",
    samples,
    async submit(batch) {
      samples.push(...batch);
    },
  };
}

export function createMetricsSinkFromEnv(): MetricsSink {
  const apiKey = getOptionalDdApiKey();
  if (apiKey === undefined) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      console.warn(METRICS_OFF_LINE);
    }
    return createNoopMetricsSink();
  }
  return createDatadogMetricsSink({ apiKey, site: process.env.DD_SITE });
}

export function spendFractionSample(micros: number, capUsd: number, atMs: number, env: Env = process.env): MetricSample {
  return {
    metric: METRICS.spendDailyFraction,
    value: dailySpendFraction(micros, capUsd),
    atMs,
    tags: baseTags(env),
  };
}

export function planOutcomeSamples(outcome: PlanOutcome, atMs: number, env: Env = process.env): readonly MetricSample[] {
  const tags = outcomeTags(outcome, env);
  return [
    { metric: METRICS.planRequests, value: 1, atMs, tags },
    { metric: METRICS.planErrors, value: errorValue(outcome.kind), atMs, tags },
  ];
}

function baseTags(env: Env): string[] {
  const tags = [SERVICE_TAG];
  const name = env.DD_ENV?.trim();
  if (name !== undefined && name.length > 0 && isSafeTagValue(name)) tags.push(`env:${name}`);
  return tags;
}

function outcomeTags(outcome: PlanOutcome, env: Env): string[] {
  const tags = baseTags(env);
  switch (outcome.kind) {
    case "completed":
      pushTag(tags, "outcome", "completed");
      break;
    case "internal_error":
      pushTag(tags, "outcome", "internal_error");
      break;
    case "spend_cap_unavailable":
      pushTag(tags, "outcome", "spend_cap_unavailable");
      break;
    case "failed":
      pushTag(tags, "outcome", "failed");
      pushTag(tags, "failure_stage", outcome.failure.stage);
      pushTag(tags, "failure_code", outcome.failure.code);
      break;
    default: {
      const neverOutcome: never = outcome;
      return neverOutcome;
    }
  }
  return tags;
}

function pushTag(tags: string[], key: string, value: string): void {
  if (!isSafeTagValue(value)) return;
  tags.push(`${key}:${value}`);
}

function errorValue(kind: PlanOutcome["kind"]): 0 | 1 {
  switch (kind) {
    case "completed":
      return 0;
    case "failed":
    case "internal_error":
    case "spend_cap_unavailable":
      return 1;
    default: {
      const neverKind: never = kind;
      return neverKind;
    }
  }
}
