import { readFileSync } from "node:fs";

export type PlacesFixtureName =
  | "combined-drinks-dinner-dessert"
  | "combined-dessert-starved"
  | "refill-dessert"
  | "mixed-quality";

export interface RawPlace {
  readonly id: string;
  readonly [key: string]: unknown;
}

export function loadPlacesFixture(name: PlacesFixtureName): { readonly places: readonly RawPlace[] } {
  return JSON.parse(readFileSync(new URL(`../fixtures/places/${name}.json`, import.meta.url), "utf8"));
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Rejects like fetch does when its signal aborts, and never resolves otherwise. */
export function hangUntilAborted(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
      once: true,
    });
  });
}
