import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { ERROR_RATE_ALERT, SPEND_ALERT_FRACTION } from "../../src/monitoring/spend-fraction";
import { applyMonitors, loadMonitors, type MonitorClient } from "../../ops/datadog/create-monitors";
import { buildDryRunReport } from "../../ops/datadog/dry-run-monitors";

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("monitor definitions", () => {
  it("alerts spend at 0.8 and the app error rate at 0.1 over one hour", () => {
    const monitors = loadMonitors();
    const report = buildDryRunReport(monitors, 5);

    assert.equal(report.spendAlert.value, 0.8);
    assert.equal(report.spendAlert.state, "alert");
    assert.equal(report.spendAlert.threshold, SPEND_ALERT_FRACTION);
    assert.equal(report.spendAlert.series.series[0].points[0][1], 0.8);
    assert.match(report.spendAlert.query, /nightcap\.spend\.daily_fraction\{service:nightcap\} >= 0\.8/);
    assert.equal(report.spendRecover.state, "ok");
    assert.equal(report.spendRecover.value, 0);

    assert.equal(report.errorAlert.value, 0.1);
    assert.equal(report.errorAlert.state, "alert");
    assert.equal(report.errorAlert.threshold, ERROR_RATE_ALERT);
    assert.equal(report.errorAlert.errors, 1);
    assert.equal(report.errorAlert.total, 10);
    assert.match(report.errorAlert.query, /last_1h/);
    assert.match(report.errorAlert.query, /source:app/);
    assert.equal(report.errorAlert.series.series[0].points[0][1], 1);
    assert.equal(report.errorAlert.series.series[1].points[0][1], 1);
    assert.equal(report.errorRecover.state, "ok");
    assert.equal(report.errorRecover.value, 0);
    assert.equal(monitors[0].options.notify_no_data, false);
    assert.equal(monitors[1].options.notify_no_data, false);
    assert.equal(monitors[1].options.require_full_window, true);
  });

  it("creates a missing monitor and updates it on the next run", async () => {
    const [spend, error] = loadMonitors();
    const calls: { url: string; method: string; body: string | undefined }[] = [];
    let spendId = 0;

    const fetchImpl: typeof fetch = (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : undefined;
      calls.push({ url, method, body });
      assert.equal(init?.redirect, "error");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("DD-API-KEY"), "api-test");
      assert.equal(headers.get("DD-APPLICATION-KEY"), "app-test");
      const query = new URL(url).searchParams.get("query") ?? "";
      if (method === "GET" && query.includes(spend.name)) {
        const monitors = spendId === 0 ? [] : [{ id: spendId, name: spend.name }];
        return Promise.resolve(new Response(JSON.stringify({ monitors }), { status: 200 }));
      }
      if (method === "GET" && query.includes(error.name)) {
        return Promise.resolve(new Response(JSON.stringify({ monitors: [] }), { status: 200 }));
      }
      if (method === "POST") {
        if (body?.includes(spend.name)) spendId = 42;
        const id = body?.includes(spend.name) ? 42 : 43;
        return Promise.resolve(new Response(JSON.stringify({ id }), { status: 200 }));
      }
      if (method === "PUT") {
        return Promise.resolve(new Response(JSON.stringify({ id: 42 }), { status: 200 }));
      }
      return Promise.reject(new Error(`unexpected ${method} ${url}`));
    };

    const client: MonitorClient = {
      apiKey: "api-test",
      appKey: "app-test",
      site: "datadoghq.com",
      fetch: fetchImpl,
    };

    const created = await applyMonitors([spend, error], client);
    assert.deepEqual(created, [
      { name: spend.name, action: "created", id: 42 },
      { name: error.name, action: "created", id: 43 },
    ]);

    calls.length = 0;
    const updated = await applyMonitors([spend], client);
    assert.deepEqual(updated, [{ name: spend.name, action: "updated", id: 42 }]);
    assert.equal(calls.some((call) => call.method === "POST"), false);
    assert.equal(calls.filter((call) => call.method === "PUT").length, 1);
    assert.equal(calls.some((call) => call.body?.includes("api-test")), false);
  });

  it("dry-run exits 0 with the key set in the environment and writes alert then OK receipts", () => {
    const dir = mkdtempSync(join(tmpdir(), "nightcap-monitors-"));
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--import", "./tests/setup.mjs", "ops/datadog/dry-run-monitors.ts"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          DD_API_KEY: "should-not-send",
          DD_APP_KEY: "should-not-send",
          DD_MONITORS_APPLY: "1",
          NIGHTCAP_MONITOR_RECEIPT_DIR: dir,
          NIGHTCAP_METRIC_TIMING: "1",
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Datadog metrics disabled: DD_API_KEY is unset/);
    assert.match(result.stderr, /Datadog exporter no-op: DD_API_KEY is unset/);
    assert.match(result.stdout, /spend monitor state=alert value=0\.8 threshold=0\.8 metric=nightcap\.spend\.daily_fraction/);
    assert.match(result.stdout, /error monitor state=alert value=0\.1 threshold=0\.1 metric=nightcap\.request\.error/);
    assert.match(result.stdout, /spend monitor state=OK value=0 threshold=0\.8/);
    assert.match(result.stdout, /error monitor state=OK value=0 threshold=0\.1/);
    assert.match(result.stdout, /exporter=noop/);
    assert.match(result.stdout, /spend metric sample at \d+ms/);

    const spend = readFileSync(join(dir, "s7-33-spend-alert.json"), "utf8");
    const errorReceipt = readFileSync(join(dir, "s7-33-error-alert.json"), "utf8");
    const recovered = readFileSync(join(dir, "s7-33-recover.json"), "utf8");
    const noop = readFileSync(join(dir, "s7-33-noop.json"), "utf8");
    assert.match(spend, /"state": "alert"/);
    assert.match(spend, /"value": 0\.8/);
    assert.match(spend, /"metric": "nightcap.spend.daily_fraction"/);
    assert.match(spend, /0\.8/);
    assert.match(errorReceipt, /"state": "alert"/);
    assert.match(errorReceipt, /"value": 0\.1/);
    assert.match(recovered, /"state": "ok"/);
    assert.match(noop, /"exporter": "noop"/);
    assert.match(noop, /"mode": "skipped"/);
    assert.equal(result.stdout.includes("should-not-send"), false);
    assert.equal(result.stderr.includes("should-not-send"), false);
  });
});
