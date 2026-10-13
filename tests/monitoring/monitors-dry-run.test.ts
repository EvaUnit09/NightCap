import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyMonitors,
  loadMonitors,
  prepareMonitors,
  validateMonitors,
  type MonitorClient,
} from "../../ops/datadog/create-monitors";
import { simulateBreach } from "../../ops/datadog/force-breach";
import { evaluateMonitor, parseMonitorQuery } from "../../ops/datadog/monitor-eval";
import { createPlanHandler } from "../../src/api/plan-stream";
import { resetConfig } from "../../src/models/config";
import { createMemoryMetricsSink, type MetricSample } from "../../src/monitoring/metrics";
import { usdToMicros, utcDay } from "../../src/monitoring/spend-cap";
import { createSpendStoreFromEnv, type SpendStore } from "../../src/monitoring/spend-store";
import { INTENT, OPTION_A, OPTION_B, REQUEST_TEXT, fakeModels, harness } from "../pipeline/orchestrator-harness";

const root = fileURLToPath(new URL("../..", import.meta.url));
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const IP = "203.0.113.9";
const SERVICE = "service:nightcap";

function post(body: unknown, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (!headers.has("x-forwarded-for")) headers.set("x-forwarded-for", IP);
  return new Request("http://localhost/api/plan", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
    headers,
  });
}

function admittedDeps() {
  return harness({
    models: fakeModels({
      parse_intent: [{ json: INTENT }],
      plan_itineraries: [{ json: { options: [OPTION_A, OPTION_B] } }],
    }),
  }).deps;
}

function summarized(samples: readonly MetricSample[]) {
  return samples.map((sample) => ({ metric: sample.metric, value: sample.value, tags: [...sample.tags] }));
}

describe("handler metric emission", () => {
  const previous = { ...process.env };

  beforeEach(() => {
    delete process.env.ENABLE_LIVE_ROUTES;
    delete process.env.RATE_LIMIT_DAILY_SPEND_USD;
    delete process.env.RATE_LIMIT_REQUESTS_PER_HOUR;
    delete process.env.DD_ENV;
    resetConfig();
  });

  afterEach(() => {
    process.env = { ...previous };
    resetConfig();
  });

  it("emits a zero error on a completed plan and both spend samples", async () => {
    const sink = createMemoryMetricsSink();
    const store = createSpendStoreFromEnv({});
    const handler = createPlanHandler(() => admittedDeps(), { store, now: () => NOW, metrics: sink });

    const response = await handler(post({ text: REQUEST_TEXT }));
    await response.text();

    assert.equal(response.status, 200);
    assert.equal(await store.readDailyMicros(utcDay(NOW)), 35_400);
    assert.deepEqual(summarized(sink.samples), [
      { metric: "nightcap.spend.daily_fraction", value: 0, tags: [SERVICE] },
      { metric: "nightcap.spend.daily_fraction", value: 35_400 / usdToMicros(5), tags: [SERVICE] },
      { metric: "nightcap.plan.requests", value: 1, tags: [SERVICE, "outcome:completed"] },
      { metric: "nightcap.plan.errors", value: 0, tags: [SERVICE, "outcome:completed"] },
    ]);
    assert.equal(JSON.stringify(sink.samples).includes("West Village"), false);
  });

  it("samples the post-add total when a failed plan still spent", async () => {
    const sink = createMemoryMetricsSink();
    const store = createSpendStoreFromEnv({});
    const handler = createPlanHandler(
      () => harness({ models: fakeModels({ parse_intent: [{ text: "not json" }] }) }).deps,
      { store, now: () => NOW, metrics: sink },
    );

    const response = await handler(post({ text: REQUEST_TEXT }));
    await response.text();

    assert.equal(await store.readDailyMicros(utcDay(NOW)), 200);
    assert.deepEqual(summarized(sink.samples), [
      { metric: "nightcap.spend.daily_fraction", value: 0, tags: [SERVICE] },
      { metric: "nightcap.spend.daily_fraction", value: 200 / usdToMicros(5), tags: [SERVICE] },
      {
        metric: "nightcap.plan.requests",
        value: 1,
        tags: [SERVICE, "outcome:failed", "failure_stage:parse", "failure_code:no_json"],
      },
      {
        metric: "nightcap.plan.errors",
        value: 1,
        tags: [SERVICE, "outcome:failed", "failure_stage:parse", "failure_code:no_json"],
      },
    ]);
  });

  it("counts a pipeline failure and skips the post-add sample when the ledger increment is zero", async () => {
    const sink = createMemoryMetricsSink();
    const store = createSpendStoreFromEnv({});
    const handler = createPlanHandler(
      () => harness({ models: fakeModels({ parse_intent: [{ error: new Error("upstream secret") }] }) }).deps,
      { store, now: () => NOW, metrics: sink },
    );

    const response = await handler(post({ text: REQUEST_TEXT }));
    await response.text();

    assert.deepEqual(summarized(sink.samples), [
      { metric: "nightcap.spend.daily_fraction", value: 0, tags: [SERVICE] },
      {
        metric: "nightcap.plan.requests",
        value: 1,
        tags: [SERVICE, "outcome:failed", "failure_stage:parse", "failure_code:model_error"],
      },
      {
        metric: "nightcap.plan.errors",
        value: 1,
        tags: [SERVICE, "outcome:failed", "failure_stage:parse", "failure_code:model_error"],
      },
    ]);
    assert.equal(JSON.stringify(sink.samples).includes("secret"), false);
  });

  it("counts an internal error when deps throw", async () => {
    const sink = createMemoryMetricsSink();
    const store = createSpendStoreFromEnv({});
    const handler = createPlanHandler(
      () => {
        throw new Error("ANTHROPIC_API_KEY missing");
      },
      { store, now: () => NOW, metrics: sink },
    );

    const response = await handler(post({ text: REQUEST_TEXT }));
    await response.text();

    assert.deepEqual(summarized(sink.samples), [
      { metric: "nightcap.spend.daily_fraction", value: 0, tags: [SERVICE] },
      { metric: "nightcap.plan.requests", value: 1, tags: [SERVICE, "outcome:internal_error"] },
      { metric: "nightcap.plan.errors", value: 1, tags: [SERVICE, "outcome:internal_error"] },
    ]);
    assert.equal(JSON.stringify(sink.samples).includes("ANTHROPIC"), false);
  });

  it("counts a 503 when the ledger cannot be read and emits no spend sample", async () => {
    const sink = createMemoryMetricsSink();
    const store: SpendStore = {
      readDailyMicros() {
        return Promise.reject(new Error("redis down"));
      },
      recordPlan() {
        return Promise.reject(new Error("hour"));
      },
      addDailyMicros() {
        return Promise.reject(new Error("spend"));
      },
    };
    const handler = createPlanHandler(() => admittedDeps(), { store, now: () => NOW, metrics: sink });

    const response = await handler(post({ text: REQUEST_TEXT }));

    assert.equal(response.status, 503);
    assert.deepEqual(summarized(sink.samples), [
      { metric: "nightcap.plan.requests", value: 1, tags: [SERVICE, "outcome:spend_cap_unavailable"] },
      { metric: "nightcap.plan.errors", value: 1, tags: [SERVICE, "outcome:spend_cap_unavailable"] },
    ]);
    assert.equal(JSON.stringify(sink.samples).includes("redis"), false);
  });

  it("counts a 503 after the pre-check when the hour counter throws", async () => {
    const sink = createMemoryMetricsSink();
    const store: SpendStore = {
      async readDailyMicros() {
        return 1_000_000;
      },
      recordPlan() {
        return Promise.reject(new Error("hour"));
      },
      addDailyMicros() {
        return Promise.reject(new Error("spend"));
      },
    };
    const handler = createPlanHandler(() => admittedDeps(), { store, now: () => NOW, metrics: sink });

    const response = await handler(post({ text: REQUEST_TEXT }));

    assert.equal(response.status, 503);
    assert.deepEqual(summarized(sink.samples), [
      { metric: "nightcap.spend.daily_fraction", value: 0.2, tags: [SERVICE] },
      { metric: "nightcap.plan.requests", value: 1, tags: [SERVICE, "outcome:spend_cap_unavailable"] },
      { metric: "nightcap.plan.errors", value: 1, tags: [SERVICE, "outcome:spend_cap_unavailable"] },
    ]);
  });

  it("emits only the spend sample on a daily cap 429", async () => {
    const sink = createMemoryMetricsSink();
    const store = createSpendStoreFromEnv({});
    await store.addDailyMicros(utcDay(NOW), usdToMicros(5));
    const handler = createPlanHandler(() => admittedDeps(), { store, now: () => NOW, metrics: sink });

    const response = await handler(post({ text: REQUEST_TEXT }));

    assert.equal(response.status, 429);
    assert.deepEqual(summarized(sink.samples), [
      { metric: "nightcap.spend.daily_fraction", value: 1, tags: [SERVICE] },
    ]);
  });

  it("emits only the spend sample on an hourly 429", async () => {
    const sink = createMemoryMetricsSink();
    const store = createSpendStoreFromEnv({});
    for (let index = 0; index < 5; index += 1) await store.recordPlan(IP, NOW);
    const handler = createPlanHandler(() => admittedDeps(), { store, now: () => NOW, metrics: sink });

    const response = await handler(post({ text: REQUEST_TEXT }));

    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), {
      error: "hourly_plan_limit",
      message: "Too many plans from this network. Try again in an hour.",
    });
    assert.deepEqual(summarized(sink.samples), [
      { metric: "nightcap.spend.daily_fraction", value: 0, tags: [SERVICE] },
    ]);
  });

  it("emits nothing for invalid JSON", async () => {
    let reads = 0;
    const sink = createMemoryMetricsSink();
    const store: SpendStore = {
      async readDailyMicros() {
        reads += 1;
        return 0;
      },
      async recordPlan() {
        return 1;
      },
      async addDailyMicros() {
        return 0;
      },
    };
    const handler = createPlanHandler(() => admittedDeps(), { store, now: () => NOW, metrics: sink });

    const response = await handler(post("{"));

    assert.equal(response.status, 400);
    assert.equal(reads, 0);
    assert.deepEqual(sink.samples, []);
  });

  it("ledgers an abort and does not count it as a request", async () => {
    const sink = createMemoryMetricsSink();
    const store = createSpendStoreFromEnv({});
    const abort = new AbortController();
    const base = admittedDeps();
    const handler = createPlanHandler(
      () => ({
        ...base,
        models: {
          async complete(request) {
            if (request.stage === "plan_itineraries") {
              abort.abort();
              throw new DOMException("The operation was aborted", "AbortError");
            }
            return base.models.complete(request);
          },
        },
      }),
      { store, now: () => NOW, metrics: sink },
    );

    const response = await handler(post({ text: REQUEST_TEXT }, { signal: abort.signal }));
    assert.equal(await response.text(), "");

    assert.equal(await store.readDailyMicros(utcDay(NOW)), 35_200);
    assert.deepEqual(summarized(sink.samples), [
      { metric: "nightcap.spend.daily_fraction", value: 0, tags: [SERVICE] },
      { metric: "nightcap.spend.daily_fraction", value: 35_200 / usdToMicros(5), tags: [SERVICE] },
    ]);
  });
});

describe("monitor queries", () => {
  const previous = { ...process.env };

  afterEach(() => {
    process.env = { ...previous };
    resetConfig();
  });

  it("parses the checked-in queries and alerts on the metrics the handler emits", async () => {
    process.env.DD_ENV = "prod";
    process.env.RATE_LIMIT_DAILY_SPEND_USD = "0.05";
    process.env.RATE_LIMIT_REQUESTS_PER_HOUR = "100";
    resetConfig();
    const monitors = loadMonitors();
    const spendMonitor = monitors.find((monitor) => monitor.query.includes("nightcap.spend.daily_fraction"));
    const errorMonitor = monitors.find((monitor) => monitor.query.includes("nightcap.plan.errors"));
    if (spendMonitor === undefined || errorMonitor === undefined) throw new Error("monitor json missing");
    const spendQuery = parseMonitorQuery(spendMonitor.query);
    const errorQuery = parseMonitorQuery(errorMonitor.query);

    assert.equal(spendQuery.metric, "nightcap.spend.daily_fraction");
    assert.equal(spendQuery.comparator, ">=");
    assert.equal(spendQuery.threshold, spendMonitor.options.thresholds.critical);
    assert.deepEqual([...spendQuery.tags], ["service:nightcap", "env:prod"]);
    assert.equal(errorQuery.metric, "nightcap.plan.errors");
    assert.equal(errorQuery.requestMetric, "nightcap.plan.requests");
    assert.equal(errorQuery.comparator, ">=");
    assert.equal(errorQuery.threshold, 0.1);
    assert.equal(spendMonitor.options.thresholds.critical, 0.8);
    assert.equal(errorMonitor.options.timeout_h, 1);
    assert.equal(spendMonitor.message.includes("@"), false);
    assert.equal(errorMonitor.message.includes("@"), false);

    let clock = NOW;
    const sink = createMemoryMetricsSink();
    const store = createSpendStoreFromEnv({});
    const handler = createPlanHandler(() => admittedDeps(), { store, now: () => clock, metrics: sink });
    await (await handler(post({ text: REQUEST_TEXT }))).text();
    await (await handler(post({ text: REQUEST_TEXT }))).text();
    const alert = evaluateMonitor(spendQuery, sink.samples, clock, "OK");
    assert.equal(alert.state, "Alert");
    assert.equal(alert.value, 70_800 / usdToMicros(0.05));

    clock = Date.UTC(2026, 9, 14, 12, 0, 0);
    await (await handler(post({ text: REQUEST_TEXT }))).text();
    const recovered = evaluateMonitor(spendQuery, sink.samples, clock, "Alert");
    assert.equal(recovered.state, "OK");
    assert.equal(recovered.value, 35_400 / usdToMicros(0.05));

    const held = evaluateMonitor(spendQuery, [], clock, "Alert");
    assert.equal(held.state, "Alert");
    assert.equal(held.value, null);

    process.env.RATE_LIMIT_DAILY_SPEND_USD = "5";
    resetConfig();
    const errorSink = createMemoryMetricsSink();
    const errorStore = createSpendStoreFromEnv({});
    const failing = createPlanHandler(
      () => harness({ models: fakeModels({ parse_intent: [{ text: "not json" }] }) }).deps,
      { store: errorStore, now: () => NOW, metrics: errorSink },
    );
    const succeeding = createPlanHandler(() => admittedDeps(), { store: errorStore, now: () => NOW, metrics: errorSink });
    for (let index = 0; index < 3; index += 1) await (await failing(post({ text: REQUEST_TEXT }))).text();
    for (let index = 0; index < 7; index += 1) await (await succeeding(post({ text: REQUEST_TEXT }))).text();
    const errorAlert = evaluateMonitor(errorQuery, errorSink.samples, NOW, "OK");
    assert.equal(errorAlert.state, "Alert");
    assert.equal(errorAlert.value, 0.3);
    for (let index = 0; index < 30; index += 1) await (await succeeding(post({ text: REQUEST_TEXT }))).text();
    const errorOk = evaluateMonitor(errorQuery, errorSink.samples, NOW, "Alert");
    assert.equal(errorOk.state, "OK");
    assert.equal(errorOk.value, 0.075);

    const completed = errorSink.samples.find((sample) => sample.tags.includes("outcome:completed"));
    if (completed === undefined) throw new Error("missing completed sample");
    assert.deepEqual(
      spendQuery.tags.filter((tag) => !completed.tags.includes(tag)),
      [],
    );
  });

  it("simulates alert then OK for both monitors", () => {
    const report = simulateBreach(loadMonitors());
    assert.equal(report.mode, "SIMULATED");
    assert.equal(report.spendAlert.state, "Alert");
    assert.equal(report.spendAlert.value, 0.85);
    assert.equal(report.spendRecover.state, "OK");
    assert.equal(report.spendRecover.value, 0.1);
    assert.equal(report.errorAlert.state, "Alert");
    assert.equal(report.errorAlert.value, 0.3);
    assert.equal(report.errorRecover.state, "OK");
    assert.equal(report.errorRecover.value, 0.075);
  });

  it("rewrites env:prod and appends a notify handle only through the create script", () => {
    const prepared = prepareMonitors(loadMonitors(), { envName: "dryrun", notify: "@oncall" });
    assert.equal(prepared[0].name.endsWith(" [dryrun]"), true);
    assert.equal(prepared[0].query.includes("env:prod"), false);
    assert.equal(prepared[0].query.includes("env:dryrun"), true);
    assert.equal(prepared[1].query.includes("env:prod"), false);
    assert.equal(prepared[1].tags.includes("env:dryrun"), true);
    assert.equal(prepared[1].message.endsWith(" @oncall"), true);
    assert.equal(loadMonitors().some((monitor) => monitor.message.includes("@")), false);
  });

  it("creates a missing monitor and updates it on the next run", async () => {
    const [spend, error] = loadMonitors();
    const calls: { url: string; method: string; body: string | undefined }[] = [];
    const known: { id: number; name: string }[] = [];

    const fetchImpl: typeof fetch = (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : undefined;
      calls.push({ url, method, body });
      assert.equal(init?.redirect, "error");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("DD-API-KEY"), "api-test");
      assert.equal(headers.get("DD-APPLICATION-KEY"), "app-test");
      if (method === "GET" && url.includes("monitor_tags=managed-by%3Aops-datadog")) {
        return Promise.resolve(new Response(JSON.stringify(known), { status: 200 }));
      }
      if (method === "POST" && url.endsWith("/api/v1/monitor/validate")) {
        return Promise.resolve(new Response("{}", { status: 200 }));
      }
      if (method === "POST" && url.endsWith("/api/v1/monitor")) {
        const id = body?.includes(spend.name) ? 42 : 43;
        const name = body?.includes(spend.name) ? spend.name : error.name;
        known.push({ id, name });
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

    await validateMonitors([spend], client);
    assert.equal(calls.some((call) => call.url.endsWith("/api/v1/monitor/validate")), true);

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

  it("dry-run prints both monitor bodies and does not send the key", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "ops/datadog/create-monitors.ts"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, DD_API_KEY: "should-not-send", DD_APP_KEY: "should-not-send", DD_MONITORS_APPLY: "1" },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /POST https:\/\/api\.datadoghq\.com\/api\/v1\/monitor/);
    assert.match(result.stdout, /nightcap\.spend\.daily_fraction/);
    assert.match(result.stdout, /nightcap\.plan\.errors/);
    assert.match(result.stdout, /nightcap\.plan\.requests/);
    assert.match(result.stdout, />= 0\.8/);
    assert.match(result.stdout, />= 0\.1/);
    assert.equal(result.stdout.includes("should-not-send"), false);
    assert.equal(result.stderr.includes("should-not-send"), false);
    assert.equal(result.stdout.includes("/api/v1/series"), false);
  });

  it("simulated breach exits 0 and writes SIMULATED receipts", () => {
    const dir = mkdtempSync(join(tmpdir(), "nightcap-monitors-"));
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--import", "./tests/setup.mjs", "ops/datadog/force-breach.ts", "--simulate"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          DD_API_KEY: "should-not-send",
          DD_APP_KEY: "should-not-send",
          NIGHTCAP_MONITOR_RECEIPT_DIR: dir,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SIMULATED spend state=Alert value=0\.85 threshold=0\.8 metric=nightcap\.spend\.daily_fraction/);
    assert.match(result.stdout, /SIMULATED error state=Alert value=0\.3 threshold=0\.1 metric=nightcap\.plan\.errors/);
    assert.match(result.stdout, /SIMULATED spend state=OK value=0\.1/);
    assert.match(result.stdout, /SIMULATED error state=OK value=0\.075/);
    assert.match(result.stdout, /mode=SIMULATED/);
    const spend = readFileSync(join(dir, "s7-33-spend-alert.json"), "utf8");
    const recovered = readFileSync(join(dir, "s7-33-recover.json"), "utf8");
    assert.match(spend, /"mode": "SIMULATED"/);
    assert.match(spend, /"state": "Alert"/);
    assert.match(recovered, /"state": "OK"/);
    assert.equal(result.stdout.includes("should-not-send"), false);
  });

  it("rejects a monitor query that is not one of the two shapes", () => {
    assert.throws(() => parseMonitorQuery("avg(last_5m):avg:nightcap.spend.daily_fraction{*} by {host} > 1"), /spend max/);
  });
});
