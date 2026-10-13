import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createPlanHandler } from "../../src/api/plan-stream";
import { resetConfig } from "../../src/models";
import { utcDay } from "../../src/monitoring/spend-cap";
import { createSpendStoreFromEnv, type SpendStore } from "../../src/monitoring/spend-store";
import { INTENT, OPTION_A, OPTION_B, REQUEST_TEXT, fakeModels, harness } from "../pipeline/orchestrator-harness";

const NOW = Date.UTC(2026, 9, 12, 22, 0, 0);
const IP = "203.0.113.7";

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

function planBody() {
  return { text: REQUEST_TEXT };
}

function admittedDeps() {
  return harness({
    models: fakeModels({ parse_intent: [{ json: INTENT }], plan_itineraries: [{ json: { options: [OPTION_A, OPTION_B] } }] }),
  }).deps;
}

describe("POST /api/plan spend cap", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetConfig();
    delete process.env.ENABLE_LIVE_ROUTES;
    delete process.env.RATE_LIMIT_REQUESTS_PER_HOUR;
    delete process.env.RATE_LIMIT_DAILY_SPEND_USD;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
  });

  it("streams done under the cap and records model, one Text Search, and two Routes hops", async () => {
    process.env.ENABLE_LIVE_ROUTES = "true";
    resetConfig();
    const store = createSpendStoreFromEnv({});
    const handler = createPlanHandler(() => admittedDeps(), { store, now: () => NOW });

    const response = await handler(post(planBody()));
    const wire = await response.text();

    assert.equal(response.status, 200);
    assert.match(wire, /event: done\ndata: \{"options":2\}/);
    assert.equal(await store.readDailyMicros(utcDay(NOW)), 400 + 35_000 + 10_000);
  });

  it("refuses the sixth plan from one IP before the pipeline starts", async () => {
    const store = createSpendStoreFromEnv({});
    let starts = 0;
    const handler = createPlanHandler(
      () => {
        starts += 1;
        return admittedDeps();
      },
      { store, now: () => NOW },
    );

    for (let i = 0; i < 5; i += 1) {
      const response = await handler(post(planBody()));
      assert.equal(response.status, 200);
      await response.text();
    }
    const refused = await handler(post(planBody()));
    const body = await refused.json();

    assert.equal(refused.status, 429);
    assert.deepEqual(body, {
      error: "hourly_plan_limit",
      message: "Too many plans from this network. Try again in an hour.",
    });
    assert.equal(starts, 5);
  });

  it("returns come back tomorrow at the daily cap and does not start the pipeline", async () => {
    const store = createSpendStoreFromEnv({});
    await store.addDailyMicros(utcDay(NOW), 4_960_000 + 35_000 + 5_000);
    let starts = 0;
    const handler = createPlanHandler(
      () => {
        starts += 1;
        return admittedDeps();
      },
      { store, now: () => NOW },
    );

    const response = await handler(post(planBody()));

    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: "daily_spend_cap", message: "Come back tomorrow." });
    assert.equal(starts, 0);
    assert.equal(await store.readDailyMicros(utcDay(NOW)), 5_000_000);
  });

  it("still admits a day that is under the cap on model spend alone", async () => {
    const store = createSpendStoreFromEnv({});
    await store.addDailyMicros(utcDay(NOW), 4_960_000);
    let starts = 0;
    const handler = createPlanHandler(
      () => {
        starts += 1;
        return admittedDeps();
      },
      { store, now: () => NOW },
    );

    const response = await handler(post(planBody()));
    await response.text();

    assert.equal(response.status, 200);
    assert.equal(starts, 1);
  });

  it("does not count invalid JSON against the hour, then refuses the sixth real plan", async () => {
    const store = createSpendStoreFromEnv({});
    let starts = 0;
    const handler = createPlanHandler(
      () => {
        starts += 1;
        return admittedDeps();
      },
      { store, now: () => NOW },
    );

    for (let i = 0; i < 5; i += 1) {
      const rejected = await handler(post("{not json"));
      assert.equal(rejected.status, 400);
      assert.deepEqual(await rejected.json(), { error: "invalid_json" });
    }
    for (let i = 0; i < 5; i += 1) {
      const response = await handler(post(planBody()));
      assert.equal(response.status, 200);
      await response.text();
    }
    const refused = await handler(post(planBody()));

    assert.equal(refused.status, 429);
    assert.deepEqual(await refused.json(), {
      error: "hourly_plan_limit",
      message: "Too many plans from this network. Try again in an hour.",
    });
    assert.equal(starts, 5);
  });

  it("keeps parse and Places spend when the plan call is aborted", async () => {
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
      { store, now: () => NOW },
    );

    const response = await handler(post(planBody(), { signal: abort.signal }));
    const wire = await response.text();

    assert.equal(wire, "");
    assert.equal(await store.readDailyMicros(utcDay(NOW)), 200 + 35_000);
  });

  it("answers 503 and skips the pipeline when the ledger cannot be read", async () => {
    const store: SpendStore = {
      readDailyMicros() {
        return Promise.reject(new Error("redis down"));
      },
      recordPlan() {
        return Promise.reject(new Error("hour counter moved"));
      },
      addDailyMicros() {
        return Promise.reject(new Error("spend moved"));
      },
    };
    let starts = 0;
    const handler = createPlanHandler(
      () => {
        starts += 1;
        return admittedDeps();
      },
      { store, now: () => NOW },
    );

    const response = await handler(post(planBody()));

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "spend_cap_unavailable" });
    assert.equal(starts, 0);
  });
});
