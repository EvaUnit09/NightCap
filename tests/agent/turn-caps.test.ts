import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runRefineAgent } from "../../src/agent";
import { baseContext, sampleCandidate, sampleIntent, sampleItinerary } from "./fixtures";
import { scriptedModel, textTurn, toolTurn } from "./scripted-model";

describe("refine agent caps", () => {
  it("hard-stops at 6 tool calls", async () => {
    const turns = [
      ...Array.from({ length: 6 }, (_, index) =>
        toolTurn("validate_itinerary", { itinerary: sampleItinerary() }, `v${index}`),
      ),
      textTurn("should not be reached if capped before next model call after 6"),
    ];
    const model = scriptedModel(turns);
    const result = await runRefineAgent(
      {
        editText: "validate the plan please",
        itinerary: sampleItinerary(),
        intent: sampleIntent(),
        candidates: sampleItinerary().options.flatMap((o) =>
          o.stops.map((s) => sampleCandidate(s.placeId)),
        ),
      },
      {
        models: model,
        retrieve: baseContext().retrieve,
        validate: async () => [],
        maxToolCalls: 6,
        maxCostUsd: 10,
        modelId: "claude-haiku-5-5",
      },
    );
    assert.equal(result.metrics.toolCalls, 6);
    assert.equal(result.metrics.stoppedReason, "max_tool_calls");
    assert.ok(model.requests().length <= 7);
  });

  it("refuses a Places search that would exceed the turn cost cap", async () => {
    let retrieves = 0;
    const model = scriptedModel([
      toolTurn("search_venues", {
        area: "SoHo",
        category: "dessert",
        priceLevel: "PRICE_LEVEL_INEXPENSIVE",
        openAt: "2026-10-16T20:00:00-04:00",
      }),
      textTurn("done"),
    ]);
    const result = await runRefineAgent(
      {
        editText: "find a cheaper dessert",
        itinerary: sampleItinerary(),
        intent: sampleIntent(),
        candidates: [sampleCandidate("place-a"), sampleCandidate("place-b")],
      },
      {
        models: model,
        retrieve: async () => {
          retrieves += 1;
          return {
            byStopType: new Map([
              [
                "dessert",
                {
                  kind: "ranked" as const,
                  candidates: [sampleCandidate("ChIJ_dessert", "Dessert", "dessert")],
                },
              ],
            ]),
            placesRequests: 1,
          };
        },
        validate: async () => [],
        maxToolCalls: 6,
        // One Text Search is $0.035, so a $0.03 cap must refuse before retrieve.
        maxCostUsd: 0.03,
        modelId: "claude-haiku-5-5",
      },
    );
    assert.equal(retrieves, 0);
    assert.equal(result.metrics.placesRequests, 0);
    assert.ok(result.metrics.costUsd <= 0.03);
    assert.equal(result.metrics.stoppedReason, "max_cost");
  });

  it("uses Haiku 5.5 by default from the router", async () => {
    const model = scriptedModel([textTurn("ok")]);
    await runRefineAgent(
      {
        editText: "make dinner cheaper",
        itinerary: sampleItinerary(),
        intent: sampleIntent(),
        candidates: [sampleCandidate("place-a")],
      },
      {
        models: model,
        retrieve: baseContext().retrieve,
        validate: async () => [],
      },
    );
    assert.equal(model.requests()[0]?.model, "claude-haiku-5-5");
  });
});
