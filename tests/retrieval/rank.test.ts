import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Candidate } from "../../src/validation/candidate";
import type { PlaceRecord } from "../../src/retrieval/places-client";
import type { PriceLevel, VenueQuery } from "../../src/retrieval/query";
import { classify, isOpenLongEnough, rankCandidates, type RankSettings } from "../../src/retrieval/rank";

type Hours = Candidate["openingHours"];

function everyDay(openHour: number, closeHour: number): Hours {
  const overnight = closeHour <= openHour;
  return Array.from({ length: 7 }, (_, day) => ({
    open: { day, hour: openHour, minute: 0 },
    close: { day: overnight ? (day + 1) % 7 : day, hour: closeHour, minute: 0 },
  }));
}

const EVENING = everyDay(17, 2);
const ALL_WEEK: Hours = [{ open: { day: 0, hour: 0, minute: 0 } }];

function place(id: string, overrides: Partial<Omit<Candidate, "stopType">> = {}, rank = 0, primaryType: string | null = "bar"): PlaceRecord {
  return {
    candidate: {
      placeId: id,
      name: `Place ${id}`,
      businessStatus: "OPERATIONAL",
      priceLevel: "PRICE_LEVEL_MODERATE",
      rating: 4.4,
      reviewCount: 500,
      location: { lat: 40.73, lng: -74.0 },
      openingHours: EVENING,
      types: ["bar"],
      ...overrides,
    },
    primaryType,
    searchRank: rank,
    pageSize: 20,
  };
}

const ALL_LEVELS: readonly PriceLevel[] = [
  "PRICE_LEVEL_FREE",
  "PRICE_LEVEL_INEXPENSIVE",
  "PRICE_LEVEL_MODERATE",
  "PRICE_LEVEL_EXPENSIVE",
  "PRICE_LEVEL_VERY_EXPENSIVE",
];

const query: VenueQuery = {
  area: "West Village",
  stopTypes: ["bar"],
  slot: { start: "2026-10-16T19:00:00-04:00", end: "2026-10-17T01:00:00-04:00" },
  acceptedPriceLevels: new Set(ALL_LEVELS),
  vibeTags: [],
};

const settings: RankSettings = {
  topK: 5,
  minOpenMinutes: 60,
  vibeWeight: 1,
  popularityWeight: 0.5,
  reviewSoftCap: 2000,
};

function ids(places: readonly PlaceRecord[], q: VenueQuery = query, s: RankSettings = settings, stopType = q.stopTypes[0]) {
  return (rankCandidates(places, q, s).get(stopType) ?? []).map((candidate) => candidate.placeId);
}

describe("rank filter", () => {
  it("never outputs a closed or future venue, even ranked first by Google", () => {
    const places = [
      place("temp", { businessStatus: "CLOSED_TEMPORARILY" }, 0),
      place("perm", { businessStatus: "CLOSED_PERMANENTLY" }, 1),
      place("future", { businessStatus: "FUTURE_OPENING" }, 2),
      place("open", {}, 19),
    ];
    assert.deepEqual(ids(places), ["open"]);
  });

  it("drops empty hours, keeps 24/7, and keeps a 21:00 to 23:00 shop in a 19:00 to 01:00 window", () => {
    const places = [
      place("nohours", { openingHours: [] }, 0),
      place("always", { openingHours: ALL_WEEK }, 1),
      place("short", { openingHours: everyDay(21, 23) }, 2),
    ];
    assert.deepEqual(ids(places).sort(), ["always", "short"]);
  });

  it("drops a venue open less than minOpenMinutes inside the slot", () => {
    const lateOpener = place("late", { openingHours: everyDay(0, 2).map((p) => ({ ...p, open: { ...p.open, hour: 0, minute: 30 } })) });
    assert.deepEqual(ids([lateOpener]), []);
    assert.deepEqual(ids([lateOpener], query, { ...settings, minOpenMinutes: 30 }), ["late"]);
  });

  it("asks only for the whole slot when the slot is shorter than minOpenMinutes", () => {
    const candidate = { ...place("x", { openingHours: everyDay(19, 23) }).candidate, stopType: "bar" as const };
    assert.equal(isOpenLongEnough(candidate, { start: "2026-10-16T20:00:00-04:00", end: "2026-10-16T20:30:00-04:00" }, 60), true);
    assert.equal(isOpenLongEnough(candidate, { start: "2026-10-16T22:45:00-04:00", end: "2026-10-16T23:15:00-04:00" }, 60), false);
  });

  it("drops levels outside the accepted band and keeps null and UNSPECIFIED", () => {
    const band: VenueQuery = { ...query, acceptedPriceLevels: new Set<PriceLevel>(["PRICE_LEVEL_INEXPENSIVE"]) };
    const places = [
      place("pricey", { priceLevel: "PRICE_LEVEL_EXPENSIVE" }, 0),
      place("cheap", { priceLevel: "PRICE_LEVEL_INEXPENSIVE" }, 1),
      place("unknown", { priceLevel: null }, 2),
      place("unspecified", { priceLevel: "PRICE_LEVEL_UNSPECIFIED" }, 3),
    ];
    assert.deepEqual(ids(places, band), ["cheap", "unknown", "unspecified"]);
  });
});

describe("rank scoring", () => {
  it("ranks a vibe-tag match above an otherwise identical place", () => {
    const tagged: VenueQuery = { ...query, vibeTags: ["wine bar"] };
    const plain = place("plain", { types: ["bar"] }, 0);
    const wine = place("wine", { types: ["wine_bar", "bar"] }, 1);
    assert.deepEqual(ids([plain, wine], tagged), ["wine", "plain"]);
  });

  it("penalizes 20k reviews above the soft cap; below it Google order holds", () => {
    const famous = place("famous", { reviewCount: 20_000 }, 0);
    const local = place("local", { reviewCount: 800 }, 1);
    assert.deepEqual(ids([famous, local]), ["local", "famous"]);
    const popularButUnderCap = place("popular", { reviewCount: 1900 }, 0);
    assert.deepEqual(ids([popularButUnderCap, local]), ["popular", "local"]);
  });

  it("breaks score ties by fewer reviews, then placeId, regardless of input order", () => {
    const a = place("a", { reviewCount: 300 }, 0);
    const b = place("b", { reviewCount: 100 }, 0);
    const c = place("c", { reviewCount: 100 }, 0);
    assert.deepEqual(ids([a, c, b]), ["b", "c", "a"]);
    assert.deepEqual(ids([c, b, a]), ["b", "c", "a"]);
  });
});

describe("rank shape", () => {
  it("keeps at most topK per stop type", () => {
    const places = Array.from({ length: 9 }, (_, i) => place(`p${i}`, {}, i));
    assert.equal(ids(places, query, { ...settings, topK: 3 }).length, 3);
  });

  it("puts a bar-and-restaurant place under one stop type only", () => {
    const both: VenueQuery = { ...query, stopTypes: ["dinner", "bar"] };
    const gastropub = place("gastropub", { types: ["restaurant", "bar"] }, 0, "gastropub");
    const ranked = rankCandidates([gastropub], both, settings);
    const appearances = [...ranked.values()].flat().filter((c) => c.placeId === "gastropub");
    assert.equal(appearances.length, 1);
  });

  it("merges the same placeId from two searches into one candidate", () => {
    const fromCombined = place("dupe", {}, 5);
    const fromRefill = { ...place("dupe", {}, 0), pageSize: 4 };
    assert.deepEqual(ids([fromCombined, fromRefill, place("other", {}, 6)]), ["dupe", "other"]);
  });

  it("classifies by primaryType first, then the highest-priority place type", () => {
    const both: VenueQuery = { ...query, stopTypes: ["drinks", "bar"] };
    assert.equal(classify(place("x", { types: ["bar", "cocktail_bar"] }, 0, "cocktail_bar"), both.stopTypes), "drinks");
    assert.equal(classify(place("y", { types: ["night_club", "bar"] }, 0, null), both.stopTypes), "bar");
    assert.equal(classify(place("z", { types: ["museum"] }, 0, "museum"), both.stopTypes), null);
  });

  it("returns every query stop type, empty when nothing survives", () => {
    const multi: VenueQuery = { ...query, stopTypes: ["bar", "dessert"] };
    const ranked = rankCandidates([place("only-bar")], multi, settings);
    assert.deepEqual([...ranked.keys()], ["bar", "dessert"]);
    assert.deepEqual(ranked.get("dessert"), []);
  });
});
