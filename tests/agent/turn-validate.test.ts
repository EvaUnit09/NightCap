import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runRefineAgent } from "../../src/agent";
import type { Itinerary } from "../../src/validation/itinerary";
import { sampleCandidate, sampleIntent, sampleItinerary } from "./fixtures";
import { scriptedModel, textTurn, toolTurn } from "./scripted-model";

describe("refine agent validate-before-final", () => {
  it("reverts when the model ends without validate_itinerary", async () => {
    const model = scriptedModel([
      toolTurn("reorder_stops", {
        optionIndex: 0,
        order: [1, 0],
        times: [
          { start: "2026-10-10T19:30:00-04:00", end: "2026-10-10T20:45:00-04:00" },
          { start: "2026-10-10T21:00:00-04:00", end: "2026-10-10T22:30:00-04:00" },
        ],
      }),
      textTurn("Reordered for you."),
    ]);
    const before = sampleItinerary();
    const result = await runRefineAgent(
      {
        editText: "start with the second stop",
        itinerary: before,
        intent: sampleIntent(),
        candidates: before.options.flatMap((o) => o.stops.map((s) => sampleCandidate(s.placeId))),
      },
      {
        models: model,
        retrieve: async () => ({ byStopType: new Map(), placesRequests: 0 }),
        validate: async () => [],
      },
    );
    assert.equal(result.kind, "reverted");
    assert.ok(result.metrics.reverts >= 1);
    assert.equal(result.itinerary.options[0].stops[0].placeId, "place-a");
    assert.match(result.reply, /last valid itinerary/i);
  });

  it("reverts and counts metrics when validate_itinerary fails", async () => {
    const model = scriptedModel([
      toolTurn("reorder_stops", {
        optionIndex: 0,
        order: [1, 0],
        times: [
          { start: "2026-10-10T19:30:00-04:00", end: "2026-10-10T20:45:00-04:00" },
          { start: "2026-10-10T21:00:00-04:00", end: "2026-10-10T22:30:00-04:00" },
        ],
      }),
      toolTurn("validate_itinerary", { itinerary: sampleItinerary() }, "val1"),
      textTurn("Tried to fix it."),
    ]);
    const before = sampleItinerary();
    const result = await runRefineAgent(
      {
        editText: "reorder please",
        itinerary: before,
        intent: sampleIntent(),
        candidates: before.options.flatMap((o) => o.stops.map((s) => sampleCandidate(s.placeId))),
      },
      {
        models: model,
        retrieve: async () => ({ byStopType: new Map(), placesRequests: 0 }),
        validate: async () => [{ code: "over_budget", message: "too much" }],
      },
    );
    assert.equal(result.kind, "reverted");
    assert.equal(result.metrics.reverts, 1);
    assert.equal(result.metrics.validatedBeforeFinal, false);
    assert.equal(result.itinerary.options[0].stops[0].placeId, before.options[0].stops[0].placeId);
  });

  it("keeps the edit when validate_itinerary passes", async () => {
    const before = sampleItinerary();
    const model = scriptedModel([
      toolTurn("reorder_stops", {
        optionIndex: 0,
        order: [1, 0],
        times: [
          { start: "2026-10-10T19:30:00-04:00", end: "2026-10-10T20:45:00-04:00" },
          { start: "2026-10-10T21:00:00-04:00", end: "2026-10-10T22:30:00-04:00" },
        ],
      }),
      (request) => {
        const last = request.messages.at(-1);
        assert.ok(last && last.role === "user" && Array.isArray(last.content));
        const block = last.content[0];
        assert.ok(block && block.type === "tool_result");
        const payload = JSON.parse(block.content) as {
          content: { itinerary: Itinerary };
        };
        return {
          stopReason: "tool_use" as const,
          content: [
            {
              type: "tool_use" as const,
              id: "val_ok",
              name: "validate_itinerary",
              input: { itinerary: payload.content.itinerary },
            },
          ],
          inputTokens: 10,
          outputTokens: 10,
        };
      },
      textTurn("Updated and validated."),
    ]);
    const result = await runRefineAgent(
      {
        editText: "swap the order of the first option",
        itinerary: before,
        intent: sampleIntent(),
        candidates: before.options.flatMap((o) => o.stops.map((s) => sampleCandidate(s.placeId))),
      },
      {
        models: model,
        retrieve: async () => ({ byStopType: new Map(), placesRequests: 0 }),
        validate: async () => [],
      },
    );
    assert.equal(result.kind, "updated");
    assert.equal(result.metrics.reverts, 0);
    assert.equal(result.metrics.validatedBeforeFinal, true);
    assert.equal(result.itinerary.options[0].stops[0].placeId, "place-b");
  });
});
