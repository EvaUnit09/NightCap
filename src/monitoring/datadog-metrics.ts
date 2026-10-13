import "server-only";

import type { MetricSample, MetricsSink } from "./metrics";

const DISTRIBUTION_PATH = "/api/v1/distribution_points";
const DEFAULT_TIMEOUT_MS = 1_500;

export interface DatadogMetricsOptions {
  readonly apiKey: string;
  readonly site?: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

let warnedTestSkip = false;

export function resetDatadogMetricsForTests(): void {
  warnedTestSkip = false;
}

export function datadogApiOrigin(site: string | undefined): string {
  const host = site === undefined || site.trim() === "" ? "datadoghq.com" : site.trim();
  if (!/^[a-z0-9.-]+$/.test(host)) {
    throw new Error("DD_SITE must be a hostname");
  }
  return `https://api.${host}`;
}

export function createDatadogMetricsSink(options: DatadogMetricsOptions): MetricsSink {
  const fetchImpl = options.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const origin = (options.baseUrl ?? datadogApiOrigin(options.site)).replace(/\/$/, "");
  return {
    kind: "datadog",
    async submit(samples) {
      if (samples.length === 0) return;
      // node --test sets NODE_TEST_CONTEXT. A key in the environment must not reach Datadog.
      if (fetchImpl === undefined && process.env.NODE_TEST_CONTEXT !== undefined) {
        if (!warnedTestSkip) {
          warnedTestSkip = true;
          console.warn("[monitoring] Datadog metrics skipped during tests");
        }
        return;
      }
      try {
        const response = await (fetchImpl ?? fetch)(`${origin}${DISTRIBUTION_PATH}`, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            "content-type": "application/json",
            "DD-API-KEY": options.apiKey,
          },
          body: JSON.stringify(distributionBody(samples)),
        });
        if (!response.ok) {
          console.warn(`[monitoring] Datadog metrics HTTP ${response.status}`);
          await response.arrayBuffer().catch(() => undefined);
          return;
        }
        await response.arrayBuffer();
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        const status = name === "TimeoutError" || name === "AbortError" ? "timeout" : "error";
        console.warn(`[monitoring] Datadog metrics HTTP ${status}`);
      }
    },
  };
}

function distributionBody(samples: readonly MetricSample[]): {
  series: { metric: string; points: [number, number[]][]; tags: string[] }[];
} {
  return {
    series: samples.map((sample) => ({
      metric: sample.metric,
      points: [[Math.floor(sample.atMs / 1000), [sample.value]]],
      tags: [...sample.tags],
    })),
  };
}
