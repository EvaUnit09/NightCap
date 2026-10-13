import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { PLAN_TEXT_MAX_CHARS } from "../../src/api/plan-request";
import { createPlanHandler } from "../../src/api/plan-stream";
import { WRAP_USER_TEXT_MAX_CHARS } from "../../src/pipeline";
import { resetConfig } from "../../src/models";
import { ModelCallError } from "../../src/pipeline";
import { INTENT, OPTION_A, OPTION_B, REQUEST_TEXT, fakeModels, harness, option } from "../pipeline/orchestrator-harness";

interface SseEvent {
  readonly event: string;
  readonly data: unknown;
}

function post(body: unknown, init: RequestInit = {}): Request {
  return new Request("http://localhost/api/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

function parseEvents(wire: string): SseEvent[] {
  return wire
    .split("\n\n")
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const [eventLine, dataLine] = chunk.split("\n");
      return { event: eventLine.slice("event: ".length), data: JSON.parse(dataLine.slice("data: ".length)) };
    });
}

const plan = (...options: unknown[]) => ({ json: { options } });
const unreachable = () => {
  throw new Error("deps must not be built for a rejected request");
};

describe("POST /api/plan", () => {
  beforeEach(() => {
    resetConfig();
    delete process.env.REPAIR_MAX_ROUNDS;
  });

  it("streams intent, one itinerary per option, then done", async () => {
    const models = fakeModels({ parse_intent: [{ json: INTENT }], plan_itineraries: [plan(OPTION_A, OPTION_B)] });
    const handler = createPlanHandler(() => harness({ models }).deps);

    const response = await handler(post({ text: REQUEST_TEXT }));

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
    assert.deepEqual(parseEvents(await response.text()), [
      { event: "intent", data: INTENT },
      { event: "itinerary", data: { index: 0, option: OPTION_A } },
      { event: "itinerary", data: { index: 1, option: OPTION_B } },
      { event: "done", data: { options: 2, itineraryIds: [] } },
    ]);
  });

  it("never sends a dropped option, including one with an invented place id", async () => {
    const invented = option("Invented", ["ChIJbar1", "Employees Only"], ["ChIJfake", "Nowhere Bistro"]);
    const models = fakeModels({
      parse_intent: [{ json: INTENT }],
      plan_itineraries: [plan(OPTION_A, invented)],
      repair_itinerary: [{ json: invented }, { json: invented }],
    });
    const handler = createPlanHandler(() => harness({ models }).deps);

    const wire = await (await handler(post({ text: REQUEST_TEXT }))).text();
    const received = parseEvents(wire);

    assert.deepEqual(received.map((e) => e.event), ["intent", "itinerary", "done"]);
    assert.deepEqual(received[1].data, { index: 0, option: OPTION_A });
    assert.deepEqual(received[2].data, { options: 1, itineraryIds: [] });
    assert.doesNotMatch(wire, /ChIJfake|Nowhere Bistro/);
  });

  it("sends intent then a typed error when no option survives", async () => {
    const bad = option("Bad", ["ChIJbar1", "Employees Only"], ["ChIJfake", "Ghost Diner"]);
    const worse = option("Worse", ["ChIJbar0", "Little Branch"], ["ChIJfake2", "Ghost Bar"]);
    const models = fakeModels({
      parse_intent: [{ json: INTENT }],
      plan_itineraries: [plan(bad, worse)],
    });
    const handler = createPlanHandler(() => harness({ models }).deps);

    const wire = await (await handler(post({ text: REQUEST_TEXT }))).text();

    assert.deepEqual(parseEvents(wire), [
      { event: "intent", data: INTENT },
      { event: "error", data: { stage: "validate", code: "no_valid_options" } },
    ]);
    assert.doesNotMatch(wire, /Ghost/);
  });

  it("sends only a stage and code when a model call fails", async () => {
    const models = fakeModels({ parse_intent: [{ error: new Error("sk-ant-SECRET upstream exploded") }] });
    const handler = createPlanHandler(() => harness({ models }).deps);

    const wire = await (await handler(post({ text: REQUEST_TEXT }))).text();

    assert.deepEqual(parseEvents(wire), [{ event: "error", data: { stage: "parse", code: "model_error" } }]);
    assert.doesNotMatch(wire, /SECRET|exploded/);
  });

  it("keeps the model error code out of the event: the client sees model_error only", async () => {
    const models = fakeModels({ parse_intent: [{ error: new ModelCallError("rate_limited") }] });
    const handler = createPlanHandler(() => harness({ models }).deps);

    const wire = await (await handler(post({ text: REQUEST_TEXT }))).text();

    assert.deepEqual(parseEvents(wire), [{ event: "error", data: { stage: "parse", code: "model_error" } }]);
    assert.doesNotMatch(wire, /rate_limited/);
  });

  it("sends a fixed internal error when deps cannot be built", async () => {
    const handler = createPlanHandler(() => {
      throw new Error("ANTHROPIC_API_KEY missing: secret detail");
    });

    const wire = await (await handler(post({ text: REQUEST_TEXT }))).text();

    assert.deepEqual(parseEvents(wire), [{ event: "error", data: { stage: "internal", code: "internal_error" } }]);
    assert.doesNotMatch(wire, /secret|ANTHROPIC/);
  });

  it("passes an abort signal to the model client and sends nothing after the client aborts", async () => {
    const abort = new AbortController();
    let seen: AbortSignal | undefined;
    const base = harness({ models: fakeModels({}) }).deps;
    const handler = createPlanHandler(() => ({
      ...base,
      models: {
        async complete(request) {
          seen = request.signal;
          abort.abort();
          throw new DOMException("aborted", "AbortError");
        },
      },
    }));

    const wire = await (await handler(post({ text: REQUEST_TEXT }, { signal: abort.signal }))).text();

    assert.ok(seen, "model client received a signal");
    assert.equal(seen.aborted, true);
    assert.equal(wire, "");
  });

  it("keeps the text cap aligned with the prompt wrapper", () => {
    assert.equal(PLAN_TEXT_MAX_CHARS, WRAP_USER_TEXT_MAX_CHARS);
  });

  it("accepts optional date, budget, and neighborhood and folds them into the user text", async () => {
    const models = fakeModels({ parse_intent: [{ json: INTENT }], plan_itineraries: [plan(OPTION_A, OPTION_B)] });
    const handler = createPlanHandler(() => harness({ models }).deps);

    const response = await handler(
      post({
        text: "drinks then dinner",
        date: "2026-10-16",
        budgetUsd: 180,
        neighborhood: "West Village",
      }),
    );

    assert.equal(response.status, 200);
    const user = models.requestsFor("parse_intent")[0]?.user ?? "";
    assert.match(user, /drinks then dinner/);
    assert.match(user, /Date: 2026-10-16/);
    assert.match(user, /Budget: \$180 for the night/);
    assert.match(user, /Neighborhood: West Village/);
  });

  for (const [name, body] of [
    ["a calendar date that does not exist", { text: "hi", date: "2026-02-31" }],
    ["a budget that is not a whole dollar amount", { text: "hi", budgetUsd: 10.5 }],
    ["a blank neighborhood", { text: "hi", neighborhood: "   " }],
    ["filters that push the text past the cap", { text: "a".repeat(PLAN_TEXT_MAX_CHARS), date: "2026-10-16" }],
  ] as const) {
    it(`rejects ${name} before the pipeline starts`, async () => {
      const response = await createPlanHandler(unreachable)(post(body));
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "invalid_request" });
    });
  }

  for (const [name, body, code] of [
    ["malformed JSON", "{not json", "invalid_json"],
    ["a missing text field", {}, "invalid_request"],
    ["a non-string text", { text: 5 }, "invalid_request"],
    ["blank text", { text: "   " }, "invalid_request"],
    ["extra fields", { text: "hi", extra: true }, "invalid_request"],
    ["oversized text", { text: "x".repeat(9_000) }, "invalid_request"],
    ["an oversized body", JSON.stringify({ text: "x".repeat(40_000) }), "too_large"],
  ] as const) {
    it(`rejects ${name} with a 400 that echoes no request text`, async () => {
      const response = await createPlanHandler(unreachable)(post(body));
      const wire = await response.text();

      assert.equal(response.status, 400);
      assert.deepEqual(JSON.parse(wire), { error: code });
      assert.doesNotMatch(wire, /not json|xxxx/);
    });
  }
});
