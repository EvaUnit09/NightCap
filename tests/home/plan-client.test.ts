import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { createSseFrameParser, streamPlan, toFailureReason, toPlanUpdate } from "../../app/_home/plan-client";
import type { PlanUpdate } from "../../app/_home/plan-state";
import type { Intent } from "../../src/validation/intent";
import { INTENT, OPTION_A, OPTION_B } from "../pipeline/orchestrator-harness";

const ONE_STOP = {
  theme: "Just dinner",
  stops: [
    {
      placeId: "ChIJdin0",
      name: "Via Carota",
      start: "2026-10-16T19:00:00-04:00",
      end: "2026-10-16T21:00:00-04:00",
      estimatedCostUsd: 120,
      why: "A quiet table",
      travelToNext: null,
    },
  ],
};

const SINGLE_INTENT: Intent = { ...INTENT, stopTypes: ["dinner"], singleStop: true };

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function collect(text: string, signal = new AbortController().signal): Promise<PlanUpdate[]> {
  const updates: PlanUpdate[] = [];
  for await (const update of streamPlan(text, signal)) updates.push(update);
  return updates;
}

function sseBody(chunks: Uint8Array[], status = 200): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { status, headers: { "Content-Type": "text/event-stream" } },
  );
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createSseFrameParser", () => {
  it("reassembles frames split mid-line and mid-code-point", () => {
    const parser = createSseFrameParser();
    const payload = "data: café\n\n";
    const cut = payload.indexOf("é");
    assert.deepEqual(parser.push(payload.slice(0, cut)), []);
    assert.deepEqual(parser.push(payload.slice(cut)), [{ event: "message", data: "café" }]);
    assert.deepEqual(parser.end(), { leftover: false });

    const split = createSseFrameParser();
    assert.deepEqual(split.push("event: intent\nda"), []);
    assert.deepEqual(split.push('ta: {"ok":true}\n\n'), [{ event: "intent", data: '{"ok":true}' }]);
    assert.deepEqual(split.push("event: done\ndata: "), []);
    assert.deepEqual(split.end(), { leftover: true });
  });
});

describe("toPlanUpdate", () => {
  it("parses a one-stop itinerary only when the intent asked for one spot", () => {
    const wire = { event: "itinerary", data: JSON.stringify({ index: 0, option: ONE_STOP }) };
    const accepted = toPlanUpdate(wire, SINGLE_INTENT);
    assert.equal(accepted.kind, "option");
    const rejected = toPlanUpdate(wire, INTENT);
    assert.deepEqual(rejected, { kind: "failed", reason: "service_unavailable" });
  });

  it("accepts a production done frame that includes itineraryIds", () => {
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    assert.deepEqual(
      toPlanUpdate({ event: "done", data: JSON.stringify({ options: 2, itineraryIds: ids }) }, INTENT),
      { kind: "done", itineraryIds: ids },
    );
    assert.deepEqual(toPlanUpdate({ event: "done", data: JSON.stringify({ options: 2 }) }, INTENT), {
      kind: "done",
      itineraryIds: [],
    });
  });

  it("maps wire stages onto friendly reasons", () => {
    assert.equal(toFailureReason("retrieve", "no_candidates"), "no_candidates");
    assert.equal(toFailureReason("retrieve", "retrieval_error"), "service_unavailable");
    assert.equal(toFailureReason("validate", "no_valid_options"), "no_valid_options");
    assert.equal(toFailureReason("redact", "too_long"), "request_rejected");
    assert.equal(toFailureReason("redact", "internal"), "service_unavailable");
    assert.equal(toFailureReason("parse", "model_error"), "service_unavailable");
    assert.equal(toFailureReason("plan", "truncated"), "service_unavailable");
    assert.equal(toFailureReason("internal", "internal_error"), "service_unavailable");
    assert.deepEqual(
      toPlanUpdate({ event: "error", data: JSON.stringify({ stage: "parse", code: "schema_invalid" }) }, null),
      { kind: "failed", reason: "service_unavailable" },
    );
    assert.deepEqual(toPlanUpdate({ event: "intent", data: "{" }, null), {
      kind: "failed",
      reason: "service_unavailable",
    });
  });
});

describe("streamPlan", () => {
  it("posts only { text } and yields domain updates from split chunks", async () => {
    const wire =
      frame("intent", INTENT) +
      frame("itinerary", { index: 0, option: OPTION_A }) +
      frame("itinerary", { index: 1, option: OPTION_B }) +
      frame("done", {
        options: 2,
        itineraryIds: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
      });
    const bytes = new TextEncoder().encode(wire);
    const splitAt = Math.floor(bytes.length / 2);
    let body = "";
    globalThis.fetch = (async (_input, init) => {
      body = String(init?.body);
      assert.equal(init?.method, "POST");
      return sseBody([bytes.slice(0, splitAt), bytes.slice(splitAt)]);
    }) as typeof fetch;

    const updates = await collect("Dinner in the West Village");
    assert.deepEqual(JSON.parse(body), { text: "Dinner in the West Village" });
    assert.deepEqual(
      updates.map((update) => update.kind),
      ["intent", "option", "option", "done"],
    );
    assert.deepEqual(updates.at(-1), {
      kind: "done",
      itineraryIds: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
    });
  });

  it("treats a done count that does not match received slots as a dropped connection", async () => {
    const wire =
      frame("intent", INTENT) + frame("itinerary", { index: 0, option: OPTION_A }) + frame("done", { options: 2 });
    globalThis.fetch = (async () => sseBody([new TextEncoder().encode(wire)])) as typeof fetch;
    const updates = await collect("Dinner");
    assert.deepEqual(updates.at(-1), { kind: "failed", reason: "connection_lost" });
    assert.equal(
      updates.some((update) => update.kind === "done"),
      false,
    );
  });

  it("parses a single-stop option with the intent flag", async () => {
    const wire =
      frame("intent", SINGLE_INTENT) +
      frame("itinerary", { index: 0, option: ONE_STOP }) +
      frame("done", { options: 1 });
    globalThis.fetch = (async () => sseBody([new TextEncoder().encode(wire)])) as typeof fetch;
    const updates = await collect("Just dinner, one spot");
    assert.equal(updates[1]?.kind, "option");
    assert.equal(updates.at(-1)?.kind, "done");
  });

  it("maps HTTP 400 to request_rejected and a short body to connection_lost", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 400 })) as typeof fetch;
    assert.deepEqual(await collect("Dinner"), [{ kind: "failed", reason: "request_rejected" }]);

    globalThis.fetch = (async () => sseBody([new TextEncoder().encode(frame("intent", INTENT))])) as typeof fetch;
    assert.deepEqual((await collect("Dinner")).at(-1), { kind: "failed", reason: "connection_lost" });
  });

  it("returns without an update when the signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = (async () => {
      throw new DOMException("aborted", "AbortError");
    }) as typeof fetch;
    assert.deepEqual(await collect("Dinner", controller.signal), []);
  });

  it("decodes a multibyte character split across chunks", async () => {
    const intent = { ...INTENT, area: "café" };
    const wire = frame("intent", intent) + frame("done", { options: 1 });
    const bytes = new TextEncoder().encode(wire);
    const start = bytes.indexOf(0xc3);
    assert.equal(bytes[start + 1], 0xa9);
    globalThis.fetch = (async () => sseBody([bytes.slice(0, start + 1), bytes.slice(start + 1)])) as typeof fetch;
    const updates = await collect("café");
    assert.equal(updates[0]?.kind, "intent");
    if (updates[0]?.kind !== "intent") return;
    assert.equal(updates[0].intent.area, "café");
    assert.deepEqual(updates.at(-1), { kind: "failed", reason: "connection_lost" });
  });
});
