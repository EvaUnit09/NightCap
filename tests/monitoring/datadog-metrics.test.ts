import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { resetConfig } from "../../src/models/config";
import {
  METRICS_DISABLED_WARNING,
  REQUEST_ERROR_METRIC,
  REQUEST_TOTAL_METRIC,
  SPEND_FRACTION_METRIC,
  publishDailySpend,
  requestFailed,
  requestSeries,
  resetDatadogMetricsForTests,
  setSeriesPosterForTests,
  spendSeries,
  submitSeries,
  type DatadogSeriesBody,
} from "../../src/monitoring/datadog-metrics";
import { createSpendStore, createMemorySpendRedis } from "../../src/monitoring/spend-store";
import { createMemoryExporter, withRequestTrace } from "../../src/monitoring/tracing";

const NOW_SEC = 1_700_000_000;

describe("datadog series", () => {
  const previous = { ...process.env };

  afterEach(() => {
    process.env = { ...previous };
    resetConfig();
    resetDatadogMetricsForTests();
  });

  it("posts the spend gauge to api/v1/series and keeps the key out of the body", async () => {
    const calls: { url: string; body: string; key: string | null }[] = [];
    const body = spendSeries(4_000_000, 5, NOW_SEC);

    const result = await submitSeries(body, {
      env: { DD_API_KEY: "dry-key", DD_SITE: "datadoghq.com" },
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(input),
          body: String(init?.body),
          key: headers.get("DD-API-KEY"),
        });
        return Promise.resolve(new Response("{}", { status: 202 }));
      },
    });

    assert.equal(result.mode, "submitted");
    if (result.mode !== "submitted") return;
    assert.equal(result.status, 202);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.datadoghq.com/api/v1/series");
    assert.equal(calls[0].key, "dry-key");
    assert.equal(calls[0].body.includes("dry-key"), false);
    const posted: unknown = JSON.parse(calls[0].body);
    assert.deepEqual(posted, {
      series: [
        {
          metric: SPEND_FRACTION_METRIC,
          type: "gauge",
          points: [[NOW_SEC, 0.8]],
          tags: ["service:nightcap"],
        },
      ],
    });
  });

  it("skips the post when DD_API_KEY is missing and warns once", async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    let fetches = 0;
    try {
      const first = await submitSeries(spendSeries(0, 5, NOW_SEC), {
        env: {},
        fetch: () => {
          fetches += 1;
          return Promise.resolve(new Response("{}", { status: 202 }));
        },
      });
      const second = await submitSeries(spendSeries(0, 5, NOW_SEC), {
        env: {},
        fetch: () => {
          fetches += 1;
          return Promise.resolve(new Response("{}", { status: 202 }));
        },
      });
      assert.deepEqual(first, { mode: "skipped", warning: METRICS_DISABLED_WARNING });
      assert.deepEqual(second, { mode: "skipped", warning: METRICS_DISABLED_WARNING });
      assert.equal(fetches, 0);
      assert.deepEqual(warnings, [METRICS_DISABLED_WARNING]);
    } finally {
      console.warn = original;
    }
  });

  it("does not call the intake host from the test runner when a key is set", async () => {
    const result = await submitSeries(spendSeries(0, 5, NOW_SEC), {
      env: { DD_API_KEY: "dry-key" },
    });
    assert.deepEqual(result, {
      mode: "skipped",
      warning: "[monitoring] Datadog metrics skipped during tests",
    });
  });

  it("rejects a non-ok series response without echoing the key", async () => {
    await assert.rejects(
      submitSeries(spendSeries(0, 5, NOW_SEC), {
        env: { DD_API_KEY: "dry-key", DD_SITE: "datadoghq.com" },
        fetch: () => Promise.resolve(new Response("nope", { status: 403 })),
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Datadog series HTTP 403");
        assert.equal(error.message.includes("dry-key"), false);
        return true;
      },
    );
  });

  it("counts a typed failure that returned instead of throwing", async () => {
    const bodies: DatadogSeriesBody[] = [];
    setSeriesPosterForTests(async (body) => {
      bodies.push(body);
      return { mode: "submitted", status: 202 };
    });

    await withRequestTrace({ requestText: "dinner with Sam", exporter: createMemoryExporter() }, (request) => {
      request.recordOutput({ status: "failed", stage: "plan", code: "model_error" });
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(bodies.length, 1);
    const metrics = new Map(bodies[0].series.map((series) => [series.metric, series]));
    assert.equal(metrics.get(REQUEST_ERROR_METRIC)?.points[0][1], 1);
    assert.equal(metrics.get(REQUEST_TOTAL_METRIC)?.points[0][1], 1);
    assert.deepEqual(metrics.get(REQUEST_ERROR_METRIC)?.tags, ["service:nightcap", "source:app"]);
    assert.equal(JSON.stringify(bodies).includes("Sam"), false);
    assert.equal(JSON.stringify(bodies).includes("model_error"), false);
  });

  it("counts a completed request as error 0 and an eval run as source eval", async () => {
    const bodies: DatadogSeriesBody[] = [];
    setSeriesPosterForTests(async (body) => {
      bodies.push(body);
      return { mode: "submitted", status: 202 };
    });

    await withRequestTrace(
      { requestText: "dinner", testCaseId: "nc-001", exporter: createMemoryExporter() },
      (request) => {
        request.recordOutput({ status: "completed", options: [] });
      },
    );
    await new Promise((resolve) => setImmediate(resolve));

    const metrics = new Map(bodies[0].series.map((series) => [series.metric, series]));
    assert.equal(metrics.get(REQUEST_ERROR_METRIC)?.points[0][1], 0);
    assert.deepEqual(metrics.get(REQUEST_TOTAL_METRIC)?.tags, ["service:nightcap", "source:eval"]);
  });

  it("counts a thrown request as an error and leaves the message out of the series", async () => {
    const bodies: DatadogSeriesBody[] = [];
    setSeriesPosterForTests(async (body) => {
      bodies.push(body);
      return { mode: "submitted", status: 202 };
    });

    await assert.rejects(
      withRequestTrace({ requestText: "dinner", exporter: createMemoryExporter() }, () => {
        throw new Error("dinner with Sam");
      }),
      (error: unknown) => error instanceof Error && error.message === "dinner with Sam",
    );
    await new Promise((resolve) => setImmediate(resolve));

    const errorPoint = bodies[0].series.find((series) => series.metric === REQUEST_ERROR_METRIC);
    assert.equal(errorPoint?.points[0][1], 1);
    assert.equal(JSON.stringify(bodies).includes("Sam"), false);
  });

  it("publishes 0.8 after the ledger reaches 80% of the cap", async () => {
    process.env.RATE_LIMIT_DAILY_SPEND_USD = "5";
    resetConfig();
    const bodies: DatadogSeriesBody[] = [];
    setSeriesPosterForTests(async (body) => {
      bodies.push(body);
      return { mode: "submitted", status: 202 };
    });
    const store = createSpendStore(createMemorySpendRedis());

    await store.addDailyMicros("2026-10-13", 4_000_000);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].series[0].metric, SPEND_FRACTION_METRIC);
    assert.equal(bodies[0].series[0].points[0][1], 0.8);
    assert.equal(bodies[0].series[0].type, "gauge");
  });

  it("treats a failed output as an error and a completed output as success", () => {
    assert.equal(requestFailed({ thrown: false, output: { status: "failed", stage: "plan", code: "model_error" } }), true);
    assert.equal(
      requestFailed({
        thrown: false,
        output: { status: "completed", options: [] },
      }),
      false,
    );
    assert.equal(requestFailed({ thrown: true, output: { status: "completed", options: [] } }), true);
    assert.deepEqual(requestSeries(true, "app", NOW_SEC).series[0].points, [[NOW_SEC, 1]]);
  });

  it("does not publish when the key and the test poster are both absent", () => {
    delete process.env.DD_API_KEY;
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    try {
      publishDailySpend(4_000_000);
      assert.deepEqual(warnings, [METRICS_DISABLED_WARNING]);
    } finally {
      console.warn = original;
    }
  });
});
