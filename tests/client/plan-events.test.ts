import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { consumePlanResponse, type PlanEmit } from "../../src/client/plan-events";
import { INTENT, OPTION_A, OPTION_B } from "../pipeline/orchestrator-harness";

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sse(body: string | ReadableStream<Uint8Array>, status = 200, contentType = "text/event-stream; charset=utf-8"): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

function chunked(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let index = 0; index < bytes.length; index += size) {
        controller.enqueue(bytes.subarray(index, index + size));
      }
      controller.close();
    },
  });
}

function recorder(): PlanEmit & {
  intents: unknown[];
  options: unknown[];
  done: number;
  failed: string[];
} {
  const intents: unknown[] = [];
  const options: unknown[] = [];
  const failed: string[] = [];
  let done = 0;
  return {
    intents,
    options,
    failed,
    get done() {
      return done;
    },
    onIntent(intent) {
      intents.push(intent);
    },
    onItinerary(option) {
      options.push(option);
    },
    onDone() {
      done += 1;
    },
    onFailed(code) {
      failed.push(code);
    },
  };
}

describe("plan SSE reader", () => {
  it("emits validated intent and itineraries from a chunked fetch body", async () => {
    const wire = frame("intent", INTENT) + frame("itinerary", { index: 0, option: OPTION_A }) + frame("itinerary", { index: 1, option: OPTION_B }) + frame("done", { options: 2 });
    const events = recorder();

    const outcome = await consumePlanResponse(sse(chunked(wire, 7)), events);

    assert.deepEqual(outcome, { kind: "streamed" });
    assert.deepEqual(events.intents, [INTENT]);
    assert.deepEqual(events.options, [OPTION_A, OPTION_B]);
    assert.equal(events.done, 1);
    assert.deepEqual(events.failed, []);
  });

  it("stops on an itinerary that has no place id and does not emit that stop", async () => {
    const broken = JSON.parse(JSON.stringify(OPTION_A)) as { stops: Array<Record<string, unknown>> };
    delete broken.stops[0].placeId;
    const wire = frame("itinerary", { index: 0, option: OPTION_B }) + frame("itinerary", { index: 1, option: broken });
    const events = recorder();

    await consumePlanResponse(sse(wire), events);

    assert.deepEqual(events.options, [OPTION_B]);
    assert.deepEqual(events.failed, ["invalid_event"]);
    assert.equal(events.done, 0);
  });

  it("reports a stream error code and emits no itinerary", async () => {
    const events = recorder();

    const outcome = await consumePlanResponse(
      sse(frame("intent", INTENT) + frame("error", { stage: "validate", code: "no_valid_options" })),
      events,
    );

    assert.deepEqual(outcome, { kind: "streamed" });
    assert.deepEqual(events.intents, [INTENT]);
    assert.deepEqual(events.options, []);
    assert.deepEqual(events.failed, ["no_valid_options"]);
  });

  it("reads a daily spend cap as JSON instead of a stream", async () => {
    const events = recorder();
    const response = Response.json(
      { error: "daily_spend_cap", message: "Come back tomorrow." },
      { status: 429 },
    );

    const outcome = await consumePlanResponse(response, events);

    assert.deepEqual(outcome, { kind: "daily_spend_cap", message: "Come back tomorrow." });
    assert.deepEqual(events.options, []);
    assert.deepEqual(events.failed, []);
  });

  it("reads an hourly plan limit as JSON instead of a stream", async () => {
    const events = recorder();
    const response = Response.json(
      { error: "hourly_plan_limit", message: "Too many plans from this network. Try again in an hour." },
      { status: 429 },
    );

    const outcome = await consumePlanResponse(response, events);

    assert.deepEqual(outcome, {
      kind: "hourly_plan_limit",
      message: "Too many plans from this network. Try again in an hour.",
    });
    assert.deepEqual(events.options, []);
  });
});
