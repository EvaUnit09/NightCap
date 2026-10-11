import { createPlacesClient } from "../../src/retrieval/places-client";
import type { RetrievalDeps, RetrievalSettings } from "../../src/retrieval/retrieve";
import { hangUntilAborted, jsonResponse, type RawPlace } from "./places-fixtures";

/** What one HTTP attempt returns: a body, an HTTP status, or a hang until timeout. */
export type Reply = { readonly places: readonly RawPlace[] } | { readonly status: number } | "hang";

/** Replies per search, keyed by includedType ("combined" when absent), consumed in order. */
export type Script = Readonly<Record<string, readonly Reply[]>>;

export const TEST_SETTINGS: RetrievalSettings = {
  topK: 5,
  minOpenMinutes: 60,
  vibeWeight: 1,
  popularityWeight: 0.5,
  reviewSoftCap: 2000,
  maxSearches: 2,
  minPerStop: 3,
  retryDelayMs: 300,
};

export interface FakePlaces {
  readonly deps: RetrievalDeps;
  readonly fetches: () => number;
  readonly searchesFor: () => readonly string[];
  /** Every placeId any reply in this run contained. */
  readonly servedIds: () => ReadonlySet<string>;
  readonly sleeps: () => readonly number[];
}

export function fakePlaces(
  script: Script,
  options: { readonly settings?: Partial<RetrievalSettings>; readonly onFetch?: () => void } = {},
): FakePlaces {
  const used = new Map<string, number>();
  const searched: string[] = [];
  const served = new Set<string>();
  const slept: number[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    options.onFetch?.();
    const key = JSON.parse(String(init?.body)).includedType ?? "combined";
    const index = used.get(key) ?? 0;
    used.set(key, index + 1);
    searched.push(key);
    const reply = script[key]?.[index];
    if (reply === undefined) throw new Error(`unscripted search ${key} #${index}`);
    if (reply === "hang") return hangUntilAborted(init);
    if ("status" in reply) return jsonResponse({ error: { code: reply.status } }, reply.status);
    reply.places.forEach((place) => served.add(place.id));
    return jsonResponse(reply);
  };
  return {
    deps: {
      places: createPlacesClient({ apiKey: "test-key", timeoutMs: 20, fetchImpl }),
      settings: { ...TEST_SETTINGS, ...options.settings },
      sleep: async (ms) => {
        slept.push(ms);
      },
    },
    fetches: () => searched.length,
    searchesFor: () => [...searched],
    servedIds: () => served,
    sleeps: () => [...slept],
  };
}
