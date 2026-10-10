import { GIVEN_NAME_EXTRA_KEYS } from "./given-names-extra";
import { GIVEN_NAME_KEYS } from "./given-names";
import { PLACE_TERMS } from "./place-terms";

function foldKey(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

export const GIVEN_NAME_SET: ReadonlySet<string> = new Set([...GIVEN_NAME_KEYS, ...GIVEN_NAME_EXTRA_KEYS]);

export const PLACE_TERM_SET: ReadonlySet<string> = new Set(PLACE_TERMS.map(foldKey));

export function foldedNameKey(token: string): string {
  return foldKey(token);
}

export function isGivenName(token: string): boolean {
  const folded = foldKey(token);
  if (GIVEN_NAME_SET.has(folded)) {
    return true;
  }
  const parts = folded.split(/['’-]/).filter(Boolean);
  return parts.length > 1 && parts.every((part) => GIVEN_NAME_SET.has(part));
}

export function placePhraseLength(foldedTokens: readonly string[], start: number): number {
  const max = Math.min(3, foldedTokens.length - start);
  for (let size = max; size >= 1; size -= 1) {
    const phrase = foldedTokens.slice(start, start + size).join(" ");
    if (PLACE_TERM_SET.has(phrase)) {
      return size;
    }
  }
  return 0;
}

export function isPlaceTerm(token: string): boolean {
  return PLACE_TERM_SET.has(foldKey(token));
}

export const GIVEN_NAME_COUNT = GIVEN_NAME_SET.size;
