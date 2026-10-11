import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { candidateSchema } from "../../src/validation/candidate";
import {
  createPlacesClient,
  parsePlace,
  PLACES_READ_FIELDS,
  PLACES_SEARCH_FIELD_MASK,
  PLACES_TEXT_SEARCH_URL,
  PlacesError,
  type PlacesErrorCode,
} from "../../src/retrieval/places-client";
import { hangUntilAborted, jsonResponse, loadPlacesFixture } from "./places-fixtures";

const request = { textQuery: "cocktail bars in West Village", includedType: undefined };

function clientReturning(body: unknown, status = 200) {
  let calls = 0;
  let init: RequestInit | undefined;
  const client = createPlacesClient({
    apiKey: "test-key",
    timeoutMs: 1000,
    fetchImpl: async (url, requestInit) => {
      calls += 1;
      init = requestInit;
      assert.equal(String(url), PLACES_TEXT_SEARCH_URL);
      return jsonResponse(body, status);
    },
  });
  return { client, calls: () => calls, init: () => init };
}

async function codeOf(promise: Promise<unknown>): Promise<PlacesErrorCode> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PlacesError, `expected PlacesError, got ${String(error)}`);
    return error.code;
  }
  assert.fail("expected the search to fail");
}

describe("Places Text Search client", () => {
  it("parses a place into id, hours, price, coords, rating, review count, and status", async () => {
    const { client } = clientReturning(loadPlacesFixture("combined-drinks-dinner-dessert"));
    const places = await client.searchText(request);
    const first = places[0];
    assert.equal(places.length, 12);
    assert.deepEqual(first.candidate, {
      placeId: "ChIJbar0",
      name: "Little Branch",
      businessStatus: "OPERATIONAL",
      priceLevel: "PRICE_LEVEL_MODERATE",
      rating: 4.5,
      reviewCount: 900,
      location: { lat: 40.733, lng: -74.003 },
      openingHours: first.candidate.openingHours,
      types: ["cocktail_bar", "bar", "point_of_interest", "establishment"],
    });
    assert.deepEqual(first.candidate.openingHours[5], {
      open: { day: 5, hour: 17, minute: 0 },
      close: { day: 6, hour: 2, minute: 0 },
    });
    assert.equal(first.primaryType, "cocktail_bar");
    assert.deepEqual([first.searchRank, first.pageSize], [0, 12]);
  });

  it("sends the read-field mask, key, NYC restriction, and one page", async () => {
    const { client, init } = clientReturning({ places: [] });
    await client.searchText({ textQuery: "dessert", includedType: "dessert_shop" });
    const headers = new Headers(init()?.headers);
    assert.equal(init()?.method, "POST");
    assert.equal(headers.get("X-Goog-Api-Key"), "test-key");
    assert.equal(headers.get("X-Goog-FieldMask"), PLACES_SEARCH_FIELD_MASK);
    const body = JSON.parse(String(init()?.body));
    assert.equal(body.textQuery, "dessert");
    assert.equal(body.includedType, "dessert_shop");
    assert.equal(body.pageSize, 20);
    assert.ok(body.locationRestriction.rectangle.low.latitude < body.locationRestriction.rectangle.high.latitude);
  });

  it("field mask is exactly the read-field list, each under places.", () => {
    assert.deepEqual(
      PLACES_SEARCH_FIELD_MASK.split(","),
      PLACES_READ_FIELDS.map((field) => `places.${field}`),
    );
    for (const required of ["id", "regularOpeningHours", "priceLevel", "location", "rating", "userRatingCount", "businessStatus"]) {
      assert.ok((PLACES_READ_FIELDS as readonly string[]).includes(required), required);
    }
  });

  it("parser reads only fields in the read-field list", () => {
    const raw = loadPlacesFixture("combined-drinks-dinner-dessert").places[0];
    const read = new Set<string>();
    const watched = new Proxy(raw, {
      get(target, key, receiver) {
        if (typeof key === "string") read.add(key);
        return Reflect.get(target, key, receiver);
      },
    });
    assert.notEqual(parsePlace(watched, 0, 1), null);
    const unlisted = [...read].filter((key) => !(PLACES_READ_FIELDS as readonly string[]).includes(key));
    assert.deepEqual(unlisted, []);
    assert.ok(read.has("userRatingCount"));
  });

  it("strips period date/truncated so every output passes the strict Candidate schema", async () => {
    const { client } = clientReturning(loadPlacesFixture("combined-drinks-dinner-dessert"));
    const places = await client.searchText(request);
    const withDate = places.find((place) => place.candidate.placeId === "ChIJdes0");
    assert.deepEqual(withDate?.candidate.openingHours[5], {
      open: { day: 5, hour: 12, minute: 0 },
      close: { day: 5, hour: 23, minute: 0 },
    });
    for (const place of places) {
      candidateSchema.parse({ ...place.candidate, stopType: "bar" });
    }
  });

  it("drops one malformed place and keeps the rest", async () => {
    const { client } = clientReturning(loadPlacesFixture("mixed-quality"));
    const ids = (await client.searchText(request)).map((place) => place.candidate.placeId);
    assert.deepEqual(ids, ["ChIJbar0", "ChIJclosed", "ChIJ247", "ChIJnohours"]);
  });

  it("reads missing price, rating, reviews, and hours as null, null, 0, and closed", async () => {
    const { client } = clientReturning(loadPlacesFixture("mixed-quality"));
    const places = await client.searchText(request);
    const diner = places.find((place) => place.candidate.placeId === "ChIJ247")?.candidate;
    const noHours = places.find((place) => place.candidate.placeId === "ChIJnohours")?.candidate;
    assert.deepEqual([diner?.priceLevel, diner?.rating, diner?.reviewCount], [null, null, 0]);
    assert.deepEqual(diner?.openingHours, [{ open: { day: 0, hour: 0, minute: 0 } }]);
    assert.deepEqual(noHours?.openingHours, []);
  });

  it("an empty body is zero places; a non-array places is malformed", async () => {
    assert.deepEqual(await clientReturning({}).client.searchText(request), []);
    assert.equal(await codeOf(clientReturning({ places: "nope" }).client.searchText(request)), "malformed");
    assert.equal(await codeOf(clientReturning([1, 2]).client.searchText(request)), "malformed");
  });

  it("classifies 429, timeout, 500, and a missing key", async () => {
    assert.equal(await codeOf(clientReturning({}, 429).client.searchText(request)), "rate_limited");
    assert.equal(await codeOf(clientReturning({}, 500).client.searchText(request)), "http_error");
    const hanging = createPlacesClient({
      apiKey: "test-key",
      timeoutMs: 10,
      fetchImpl: async (_url, init) => hangUntilAborted(init),
    });
    assert.equal(await codeOf(hanging.searchText(request)), "timeout");
    let fetches = 0;
    const keyless = createPlacesClient({
      apiKey: undefined,
      timeoutMs: 1000,
      fetchImpl: async () => {
        fetches += 1;
        return jsonResponse({});
      },
    });
    assert.equal(await codeOf(keyless.searchText(request)), "missing_key");
    assert.equal(fetches, 0);
  });

  it("a parent abort rejects with the parent's reason, not a PlacesError", async () => {
    const parent = new AbortController();
    const client = createPlacesClient({
      apiKey: "test-key",
      timeoutMs: 1000,
      fetchImpl: async (_url, init) => {
        queueMicrotask(() => parent.abort(new Error("user left")));
        return hangUntilAborted(init);
      },
    });
    await assert.rejects(client.searchText(request, parent.signal), (error) => {
      assert.ok(!(error instanceof PlacesError));
      assert.equal((error as Error).message, "user left");
      return true;
    });
  });
});
