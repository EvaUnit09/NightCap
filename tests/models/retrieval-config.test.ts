import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { getRetrievalSettings, resetConfig } from "../../src/models";

const RETRIEVAL_ENV = [
  "PLACES_TIMEOUT_MS",
  "PLACES_RETRY_DELAY_MS",
  "PLACES_MAX_SEARCHES_PER_REQUEST",
  "RETRIEVAL_TOP_K",
  "RETRIEVAL_MIN_PER_STOP",
  "RETRIEVAL_MIN_OPEN_MINUTES",
  "RERANK_VIBE_WEIGHT",
  "RERANK_POPULARITY_WEIGHT",
  "RERANK_REVIEW_SOFT_CAP",
] as const;

describe("getRetrievalSettings", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const name of RETRIEVAL_ENV) delete process.env[name];
    resetConfig();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
  });

  it("applies the documented defaults", () => {
    assert.deepEqual(getRetrievalSettings(), {
      placesTimeoutMs: 5000,
      retryDelayMs: 300,
      maxSearches: 2,
      topK: 5,
      minPerStop: 3,
      minOpenMinutes: 60,
      vibeWeight: 1,
      popularityWeight: 0.5,
      reviewSoftCap: 2000,
    });
  });

  it("reads every knob from its env var", () => {
    process.env.PLACES_TIMEOUT_MS = "2500";
    process.env.PLACES_RETRY_DELAY_MS = "0";
    process.env.PLACES_MAX_SEARCHES_PER_REQUEST = "1";
    process.env.RETRIEVAL_TOP_K = "8";
    process.env.RETRIEVAL_MIN_PER_STOP = "8";
    process.env.RETRIEVAL_MIN_OPEN_MINUTES = "90";
    process.env.RERANK_VIBE_WEIGHT = "2.5";
    process.env.RERANK_POPULARITY_WEIGHT = "0";
    process.env.RERANK_REVIEW_SOFT_CAP = "500";
    assert.deepEqual(getRetrievalSettings(), {
      placesTimeoutMs: 2500,
      retryDelayMs: 0,
      maxSearches: 1,
      topK: 8,
      minPerStop: 8,
      minOpenMinutes: 90,
      vibeWeight: 2.5,
      popularityWeight: 0,
      reviewSoftCap: 500,
    });
  });

  it("treats a blank env var as unset", () => {
    process.env.RETRIEVAL_TOP_K = "  ";
    assert.equal(getRetrievalSettings().topK, 5);
  });

  const outOfBounds: ReadonlyArray<readonly [string, string]> = [
    ["PLACES_TIMEOUT_MS", "99"],
    ["PLACES_TIMEOUT_MS", "30001"],
    ["PLACES_RETRY_DELAY_MS", "-1"],
    ["PLACES_RETRY_DELAY_MS", "5001"],
    ["PLACES_MAX_SEARCHES_PER_REQUEST", "0"],
    ["PLACES_MAX_SEARCHES_PER_REQUEST", "5"],
    ["RETRIEVAL_TOP_K", "0"],
    ["RETRIEVAL_TOP_K", "21"],
    ["RETRIEVAL_TOP_K", "2.5"],
    ["RETRIEVAL_MIN_PER_STOP", "0"],
    ["RETRIEVAL_MIN_OPEN_MINUTES", "14"],
    ["RETRIEVAL_MIN_OPEN_MINUTES", "241"],
    ["RERANK_VIBE_WEIGHT", "-0.1"],
    ["RERANK_VIBE_WEIGHT", "10.1"],
    ["RERANK_POPULARITY_WEIGHT", "11"],
    ["RERANK_REVIEW_SOFT_CAP", "0"],
    ["RERANK_REVIEW_SOFT_CAP", "abc"],
  ];
  for (const [name, value] of outOfBounds) {
    it(`rejects ${name}=${value}`, () => {
      process.env[name] = value;
      assert.throws(() => getRetrievalSettings());
    });
  }

  it("rejects RETRIEVAL_MIN_PER_STOP above RETRIEVAL_TOP_K", () => {
    process.env.RETRIEVAL_TOP_K = "3";
    process.env.RETRIEVAL_MIN_PER_STOP = "4";
    assert.throws(() => getRetrievalSettings(), /RETRIEVAL_MIN_PER_STOP must not exceed RETRIEVAL_TOP_K/);
  });
});
