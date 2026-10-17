import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";

import { resetConfig } from "../../src/models/config";
import { resetDatadogMetricsForTests, createDatadogMetricsSink } from "../../src/monitoring/datadog-metrics";
import {
  METRICS_OFF_LINE,
  createMemoryMetricsSink,
  createMetricsSinkFromEnv,
  planOutcomeSamples,
  resetMetricsForTests,
  spendFractionSample,
} from "../../src/monitoring/metrics";

const AT_MS = 1_700_000_000_000;
const SENTINEL_KEY = "dd-sentinel-datadog-0003";
const REQUEST_TEXT = "dinner with Sarah Connor in the West Village";

describe("plan metrics", () => {
  const previous = { ...process.env };

  afterEach(() => {
    process.env = { ...previous };
    resetConfig();
    resetMetricsForTests();
    resetDatadogMetricsForTests();
  });

  it("emits requests 1 and errors 0 on success, and errors 1 with stage tags on failure", () => {
    const completed = planOutcomeSamples({ kind: "completed" }, AT_MS, {});
    const failed = planOutcomeSamples({ kind: "failed", failure: { stage: "parse", code: "no_json" } }, AT_MS, {
      DD_ENV: "prod",
    });

    assert.deepEqual(completed, [
      {
        metric: "nightcap.plan.requests",
        value: 1,
        atMs: AT_MS,
        tags: ["service:nightcap", "outcome:completed"],
      },
      {
        metric: "nightcap.plan.errors",
        value: 0,
        atMs: AT_MS,
        tags: ["service:nightcap", "outcome:completed"],
      },
    ]);
    assert.deepEqual(failed, [
      {
        metric: "nightcap.plan.requests",
        value: 1,
        atMs: AT_MS,
        tags: ["service:nightcap", "env:prod", "outcome:failed", "failure_stage:parse", "failure_code:no_json"],
      },
      {
        metric: "nightcap.plan.errors",
        value: 1,
        atMs: AT_MS,
        tags: ["service:nightcap", "env:prod", "outcome:failed", "failure_stage:parse", "failure_code:no_json"],
      },
    ]);
    assert.equal(JSON.stringify(failed).includes("Sarah"), false);
    assert.equal(JSON.stringify(failed).includes(REQUEST_TEXT), false);
  });

  it("drops an unsafe DD_ENV and keeps the spend fraction", () => {
    assert.deepEqual(spendFractionSample(4_000_000, 5, AT_MS, { DD_ENV: "prod staged" }), {
      metric: "nightcap.spend.daily_fraction",
      value: 0.8,
      atMs: AT_MS,
      tags: ["service:nightcap"],
    });
  });

  it("posts distribution points to a local intake and leaves the key and request text out of the body", async () => {
    const received: { path: string; key: string | undefined; body: string }[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received.push({
          path: req.url ?? "",
          key: req.headers["dd-api-key"]?.toString(),
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(202, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    try {
      const sink = createDatadogMetricsSink({
        apiKey: SENTINEL_KEY,
        baseUrl: `http://127.0.0.1:${port}`,
        fetch: globalThis.fetch,
      });
      await sink.submit([
        spendFractionSample(4_000_000, 5, AT_MS, { DD_ENV: "prod" }),
        ...planOutcomeSamples({ kind: "completed" }, AT_MS, { DD_ENV: "prod" }),
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    assert.equal(received.length, 1);
    assert.equal(received[0].path, "/api/v1/distribution_points");
    assert.equal(received[0].key, SENTINEL_KEY);
    assert.equal(received[0].body.includes(SENTINEL_KEY), false);
    assert.equal(received[0].body.includes("Sarah"), false);
    assert.equal(received[0].body.includes("/api/v1/series"), false);
    const posted: unknown = JSON.parse(received[0].body);
    assert.deepEqual(posted, {
      series: [
        {
          metric: "nightcap.spend.daily_fraction",
          points: [[1_700_000_000, [0.8]]],
          tags: ["service:nightcap", "env:prod"],
        },
        {
          metric: "nightcap.plan.requests",
          points: [[1_700_000_000, [1]]],
          tags: ["service:nightcap", "env:prod", "outcome:completed"],
        },
        {
          metric: "nightcap.plan.errors",
          points: [[1_700_000_000, [0]]],
          tags: ["service:nightcap", "env:prod", "outcome:completed"],
        },
      ],
    });
  });

  it("swallows a 403 and a timeout without the key or the response body", async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    try {
      const denied = createDatadogMetricsSink({
        apiKey: SENTINEL_KEY,
        fetch: () => Promise.resolve(new Response("secret-body-token", { status: 403 })),
      });
      await denied.submit([spendFractionSample(0, 5, AT_MS, {})]);
      const timedOut = createDatadogMetricsSink({
        apiKey: SENTINEL_KEY,
        fetch: () => Promise.reject(Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" })),
      });
      await timedOut.submit([spendFractionSample(0, 5, AT_MS, {})]);
    } finally {
      console.warn = original;
    }

    assert.deepEqual(warnings, [
      "[monitoring] Datadog metrics HTTP 403",
      "[monitoring] Datadog metrics HTTP timeout",
    ]);
    assert.equal(warnings.join("\n").includes(SENTINEL_KEY), false);
    assert.equal(warnings.join("\n").includes("secret-body-token"), false);
  });

  it("logs once and does not call fetch when DD_API_KEY is unset", async () => {
    delete process.env.DD_API_KEY;
    delete process.env.DATADOG_API_KEY;
    resetConfig();
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    let fetches = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      fetches += 1;
      return Promise.resolve(new Response("{}", { status: 202 }));
    };
    try {
      const first = createMetricsSinkFromEnv();
      const second = createMetricsSinkFromEnv();
      await first.submit([spendFractionSample(0, 5, AT_MS, {})]);
      await second.submit([spendFractionSample(0, 5, AT_MS, {})]);
      assert.equal(first.kind, "noop");
      assert.equal(second.kind, "noop");
    } finally {
      console.warn = original;
      globalThis.fetch = originalFetch;
    }

    assert.equal(fetches, 0);
    assert.deepEqual(warnings, [METRICS_OFF_LINE]);
  });

  it("does not call the intake host from the test runner when a key is set", async () => {
    process.env.DD_API_KEY = SENTINEL_KEY;
    resetConfig();
    let fetches = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      fetches += 1;
      return Promise.resolve(new Response("{}", { status: 202 }));
    };
    try {
      const sink = createMetricsSinkFromEnv();
      assert.equal(sink.kind, "datadog");
      await sink.submit([spendFractionSample(0, 5, AT_MS, {})]);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(fetches, 0);
  });

  it("keeps submitted samples on the memory sink", async () => {
    const sink = createMemoryMetricsSink();
    await sink.submit(planOutcomeSamples({ kind: "internal_error" }, AT_MS, {}));
    assert.equal(sink.samples[0].metric, "nightcap.plan.requests");
    assert.equal(sink.samples[1].value, 1);
    assert.deepEqual(sink.samples[1].tags, ["service:nightcap", "outcome:internal_error"]);
  });
});
