import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMemoryExporter, withRequestTrace, type CapturedSpan } from "../../src/monitoring";
import type { Intent } from "../../src/validation/intent";
import { DEFAULT_PRICE_RANGES } from "../../src/validation/defaults";
import {
  allCandidates,
  queryFromIntent,
  queryFromSearchVenues,
  retrieveVenues,
  type Retrieval,
  type StopOutcome,
  type VenueQuery,
} from "../../src/retrieval";
import { fakePlaces, type FakePlaces, type Script } from "./fake-places";
import { loadPlacesFixture } from "./places-fixtures";

const full = loadPlacesFixture("combined-drinks-dinner-dessert");
const starved = loadPlacesFixture("combined-dessert-starved");
const dessertRefill = loadPlacesFixture("refill-dessert");
const noDessert = { places: starved.places.filter((place) => !place.id.startsWith("ChIJdes")) };

const intent: Intent = {
  area: "West Village",
  window: { start: "2026-10-16T19:00:00-04:00", end: "2026-10-17T01:00:00-04:00" },
  budgetUsd: 200,
  dietary: [],
  vibeTags: ["Cozy", "cocktail"],
  stopTypes: ["drinks", "dinner", "dessert"],
  singleStop: false,
};

const query = queryFromIntent(intent, { priceRanges: DEFAULT_PRICE_RANGES, partySize: 2 });

async function traced(fake: FakePlaces, q: VenueQuery = query, signal?: AbortSignal) {
  const exporter = createMemoryExporter();
  const result = await withRequestTrace({ requestText: "r", exporter }, () => retrieveVenues(q, fake.deps, signal));
  const spans: readonly CapturedSpan[] = exporter.traces[0].spans;
  return { result, spans, searchSpans: spans.filter((span) => span.name === "places.search") };
}

function kinds(result: Retrieval): Record<string, string> {
  return Object.fromEntries(
    [...result.byStopType].map(([stopType, outcome]: [string, StopOutcome]) => [
      stopType,
      outcome.kind === "ranked" ? `ranked:${outcome.candidates.length}` : `gap:${outcome.reason}`,
    ]),
  );
}

describe("retrieveVenues retry and partial results", () => {
  it("retries a 429 once and returns the full result with one ok span", async () => {
    const fake = fakePlaces({ combined: [{ status: 429 }, full] });
    const { result, searchSpans } = await traced(fake);
    assert.deepEqual(kinds(result), { drinks: "ranked:4", dinner: "ranked:4", dessert: "ranked:4" });
    assert.equal(fake.fetches(), 2);
    assert.equal(result.placesRequests, 2);
    assert.deepEqual(fake.sleeps(), [300]);
    assert.deepEqual(searchSpans.map((span) => [span.attributes.status, span.attributes.error_code]), [["ok", undefined]]);
  });

  it("429 twice: every stop is a rate-limit gap, 2 fetches, one error span", async () => {
    const fake = fakePlaces({ combined: [{ status: 429 }, { status: 429 }] });
    const { result, searchSpans } = await traced(fake);
    assert.deepEqual(kinds(result), {
      drinks: "gap:places_rate_limited",
      dinner: "gap:places_rate_limited",
      dessert: "gap:places_rate_limited",
    });
    assert.equal(fake.fetches(), 2);
    assert.deepEqual(
      searchSpans.map((span) => [span.attributes.status, span.attributes.error_code, span.attributes.cache]),
      [["error", "rate_limited", "miss"]],
    );
  });

  it("timeout twice: no candidates at all and no further searches", async () => {
    const fake = fakePlaces({ combined: ["hang", "hang"] });
    const { result, searchSpans } = await traced(fake);
    assert.deepEqual(allCandidates(result), []);
    assert.deepEqual(new Set(Object.values(kinds(result))), new Set(["gap:places_timeout"]));
    assert.deepEqual(fake.searchesFor(), ["combined", "combined"]);
    assert.equal(searchSpans[0].attributes.error_code, "timeout");
  });

  it("does not retry a 500", async () => {
    const fake = fakePlaces({ combined: [{ status: 500 }] });
    const { result } = await traced(fake);
    assert.equal(fake.fetches(), 1);
    assert.equal(kinds(result).dinner, "gap:places_unavailable");
  });

  it("failed dessert refill keeps the combined search's dessert and the other stops", async () => {
    const fake = fakePlaces({ combined: [starved], dessert_shop: [{ status: 429 }, { status: 429 }] });
    const { result, searchSpans } = await traced(fake);
    assert.deepEqual(kinds(result), { drinks: "ranked:4", dinner: "ranked:4", dessert: "ranked:1" });
    assert.deepEqual(allCandidates(result).filter((c) => c.stopType === "dessert").map((c) => c.placeId), ["ChIJdes3"]);
    assert.deepEqual(searchSpans.map((span) => span.attributes.status), ["ok", "error"]);
  });

  it("failed refill is a gap only for a stop the combined search left empty", async () => {
    const fake = fakePlaces({ combined: [noDessert], dessert_shop: [{ status: 429 }, { status: 429 }] });
    const { result } = await traced(fake);
    assert.deepEqual(kinds(result), { drinks: "ranked:4", dinner: "ranked:4", dessert: "gap:places_rate_limited" });
  });

  it("a successful refill fills the starved stop", async () => {
    const fake = fakePlaces({ combined: [starved], dessert_shop: [dessertRefill] });
    const { result } = await traced(fake);
    assert.equal(kinds(result).dessert, "ranked:4");
    assert.deepEqual(fake.searchesFor(), ["combined", "dessert_shop"]);
  });

  it("skips refills after the combined search needed a retry", async () => {
    const fake = fakePlaces({ combined: [{ status: 429 }, noDessert] });
    const { result } = await traced(fake);
    assert.deepEqual(fake.searchesFor(), ["combined", "combined"]);
    assert.equal(kinds(result).dessert, "gap:places_rate_limited");
  });

  it("an empty but successful search is no_matches, not an outage", async () => {
    const fake = fakePlaces({ cocktail_bar: [{ places: [] }] });
    const { result } = await traced(fake, { ...query, stopTypes: ["drinks"] });
    assert.deepEqual(kinds(result), { drinks: "gap:no_matches" });
  });

  it("a single-stop query never repeats its already targeted search", async () => {
    const fake = fakePlaces({ dessert_shop: [{ places: [dessertRefill.places[0]] }] });
    const { result } = await traced(fake, { ...query, stopTypes: ["dessert"] });
    assert.deepEqual(fake.searchesFor(), ["dessert_shop"]);
    assert.equal(kinds(result).dessert, "ranked:1");
  });

  it("a parent abort rejects and is never retried", async () => {
    const parent = new AbortController();
    const fake = fakePlaces({ combined: ["hang", full] }, { onFetch: () => queueMicrotask(() => parent.abort()) });
    await assert.rejects(traced(fake, query, parent.signal), { name: "AbortError" });
    assert.equal(fake.fetches(), 1);
    assert.deepEqual(fake.sleeps(), []);
  });
});

describe("retrieveVenues cost and grounding", () => {
  it("a full combined page costs exactly one search", async () => {
    const fake = fakePlaces({ combined: [full] });
    const { result, spans } = await traced(fake);
    assert.equal(fake.fetches(), 1);
    assert.equal(result.placesRequests, 1);
    assert.deepEqual(spans.map((span) => span.name), ["places.search", "rerank"]);
  });

  it("two starved stops under a cap of 2 still send at most 2 searches", async () => {
    const fourStops: VenueQuery = { ...query, stopTypes: ["drinks", "dinner", "dessert", "activity"] };
    const fake = fakePlaces({ combined: [noDessert], dessert_shop: [dessertRefill], tourist_attraction: [{ places: [] }] });
    const { result } = await traced(fake, fourStops);
    assert.deepEqual(fake.searchesFor(), ["combined", "dessert_shop"]);
    assert.equal(kinds(result).activity, "gap:no_matches");
  });

  it("every returned placeId came from a Places reply in this call, once", async () => {
    const fake = fakePlaces({ combined: [starved], dessert_shop: [dessertRefill] });
    const { result } = await traced(fake);
    const ids = allCandidates(result).map((candidate) => candidate.placeId);
    assert.ok(ids.length > 0);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.ok(fake.servedIds().has(id), `${id} was never served`);
  });

  it("intent and search_venues queries for one stop give the same ranked ids", async () => {
    const fromIntent = queryFromIntent(
      { ...intent, stopTypes: ["dessert"], singleStop: true, vibeTags: [] },
      { priceRanges: DEFAULT_PRICE_RANGES, partySize: 2 },
    );
    const fromTool = queryFromSearchVenues(
      { tool: "search_venues", area: "West Village", category: "dessert", priceLevel: "PRICE_LEVEL_INEXPENSIVE", openAt: "2026-10-16T20:00:00-04:00" },
      { minOpenMinutes: 60 },
    );
    const script: Script = { dessert_shop: [dessertRefill] };
    const a = await traced(fakePlaces(script), fromIntent);
    const b = await traced(fakePlaces(script), fromTool);
    const ids = (r: Retrieval) => allCandidates(r).map((candidate) => candidate.placeId);
    assert.deepEqual(ids(a.result), ids(b.result));
    assert.equal(ids(a.result).length, 4);
  });

  it("puts no area, vibe tag, or venue name on any span", async () => {
    const fake = fakePlaces({ combined: [starved], dessert_shop: [{ status: 429 }, { status: 429 }] });
    const exporter = createMemoryExporter();
    await withRequestTrace({ requestText: "r", exporter }, () => retrieveVenues(query, fake.deps));
    const blob = JSON.stringify(exporter.traces).toLowerCase();
    for (const text of ["west village", "cozy", "cocktail", "little branch", "via carota", "textquery"]) {
      assert.equal(blob.includes(text), false, `${text} leaked into a span`);
    }
  });
});

describe("query adapters", () => {
  it("price band drops levels whose per-person minimum exceeds the budget", () => {
    const tight = queryFromIntent({ ...intent, budgetUsd: 100 }, { priceRanges: DEFAULT_PRICE_RANGES, partySize: 2 });
    assert.deepEqual([...tight.acceptedPriceLevels].sort(), [
      "PRICE_LEVEL_FREE",
      "PRICE_LEVEL_INEXPENSIVE",
      "PRICE_LEVEL_MODERATE",
    ]);
  });

  it("every accepted level has a party cost within budget that passes implausible_cost", () => {
    for (const budgetUsd of [10, 40, 160, 300, 2000]) {
      const q = queryFromIntent({ ...intent, budgetUsd }, { priceRanges: DEFAULT_PRICE_RANGES, partySize: 2 });
      for (const [level, [min]] of Object.entries(DEFAULT_PRICE_RANGES)) {
        const someCostFits = min * 2 <= budgetUsd;
        assert.equal(q.acceptedPriceLevels.has(level as keyof typeof DEFAULT_PRICE_RANGES), someCostFits, `${level} at $${budgetUsd}`);
      }
    }
  });

  it("normalizes vibe tags and dedupes stop types", () => {
    const q = queryFromIntent(
      { ...intent, vibeTags: [" Cozy ", "cozy", "Live Jazz"], stopTypes: ["bar", "dinner", "bar"] },
      { priceRanges: DEFAULT_PRICE_RANGES, partySize: 2 },
    );
    assert.deepEqual(q.vibeTags, ["cozy", "live jazz"]);
    assert.deepEqual(q.stopTypes, ["bar", "dinner"]);
  });

  it("search_venues gets its exact level, or every level for UNSPECIFIED", () => {
    const base = { tool: "search_venues", area: "SoHo", category: "bar", openAt: "2026-10-16T21:00:00-04:00" } as const;
    const exact = queryFromSearchVenues({ ...base, priceLevel: "PRICE_LEVEL_EXPENSIVE" }, { minOpenMinutes: 60 });
    const any = queryFromSearchVenues({ ...base, priceLevel: "PRICE_LEVEL_UNSPECIFIED" }, { minOpenMinutes: 60 });
    assert.deepEqual([...exact.acceptedPriceLevels], ["PRICE_LEVEL_EXPENSIVE"]);
    assert.equal(any.acceptedPriceLevels.size, 5);
    assert.equal(Date.parse(exact.slot.end) - Date.parse(exact.slot.start), 60 * 60_000);
  });
});
