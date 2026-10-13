import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runRefineAgent } from "../../src/agent";
import { baseContext, sampleCandidate, sampleIntent, sampleItinerary } from "./fixtures";
import { scriptedModel, textTurn, toolTurn } from "./scripted-model";

describe("refine agent guards", () => {
  it("refuses off-topic requests without calling tools", async () => {
    const model = scriptedModel([textTurn("should not run")]);
    const result = await runRefineAgent(
      {
        editText: "Write me a Python script to scrape websites",
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
    assert.equal(result.kind, "refused");
    assert.equal(result.metrics.refused, true);
    assert.equal(result.metrics.toolCalls, 0);
    assert.equal(model.requests().length, 0);
  });

  it("wraps user edit text as data for the model", async () => {
    const model = scriptedModel([textTurn("noted")]);
    await runRefineAgent(
      {
        editText: "swap the bar for dessert",
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
    const user = model.requests()[0]?.messages[0];
    assert.ok(user && user.role === "user");
    assert.equal(typeof user.content, "string");
    assert.match(String(user.content), /<user_text>/);
    assert.match(String(user.content), /swap the bar for dessert/);
    assert.match(String(user.content), /Current itinerary \(JSON data\):/);
  });

  it("does not count a no-op turn as a revert", async () => {
    const model = scriptedModel([textTurn("Looks good as is.")]);
    const result = await runRefineAgent(
      {
        editText: "does this still look good?",
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
      },
    );
    assert.equal(result.kind, "updated");
    assert.equal(result.metrics.reverts, 0);
  });

  it("rejects inventing a venue id not returned by search_venues this turn", async () => {
    const model = scriptedModel([
      toolTurn("replace_stop", { optionIndex: 0, stopIndex: 0, placeId: "invented-place" }),
      textTurn("done"),
    ]);
    const before = sampleItinerary();
    const result = await runRefineAgent(
      {
        editText: "use invented-place for dinner",
        itinerary: before,
        intent: sampleIntent(),
        candidates: before.options.flatMap((o) => o.stops.map((s) => sampleCandidate(s.placeId))),
      },
      {
        models: model,
        retrieve: baseContext().retrieve,
        validate: async () => [],
      },
    );
    assert.equal(result.itinerary.options[0].stops[0].placeId, "place-a");
  });
});
