/**
 * PII redaction for NightCap.
 *
 * Deterministic, no network, no LLM. The choke point before a DB write or
 * span attribute. This is a defense layer, not a guarantee: Datadog spans
 * carry parsed_intent plus a hash (Noah).
 *
 * Weak cues such as "with X" redact a bare capitalized token only when it is
 * in the bundled given-name list and is not a place/calendar/cuisine term.
 * Strong cues (relations, "X and I", "X's <event>") may redact any
 * proper-name-shaped token. Lowercase tokens are names only when they are in
 * the given-name list.
 *
 * Input length is measured in Unicode code points. Above MAX_INPUT_CHARS the
 * result is `{ ok: false, error: "too_long", text: "" }`. Callers must reject
 * oversized requests before redaction (route-level Zod max ~2000, to be wired
 * later) and must never forward an error result to the LLM.
 *
 * Known limits:
 * - Context-free given names ("Sarah went") are not redacted.
 * - CJK names have no case and are not in the SSA extract.
 * - Venues that are also given names (Lilia, Dante, Chelsea-the-person) can
 *   still be redacted after a weak "with" unless they are a place term.
 * - The given-name list is SSA 1880–2008 plus a short international addendum;
 *   rare or newly coined names can leak after a weak cue.
 * - Non-Latin orthographies after a weak cue survive unless the folded form
 *   is in the list (Ольга ≠ olga).
 */

import {
  foldedNameKey,
  isGivenName,
  isPlaceTerm,
  placePhraseLength,
} from "./data/lookup";

export const MAX_INPUT_CHARS = 4096;

export interface RedactionCounts {
  readonly names: number;
  readonly emails: number;
  readonly phones: number;
  readonly addresses: number;
}

export type RedactionErrorCode = "too_long" | "internal";

export type RedactionResult =
  | { readonly ok: true; readonly text: string; readonly counts: RedactionCounts }
  | {
      readonly ok: false;
      readonly error: RedactionErrorCode;
      readonly text: "";
      readonly counts: RedactionCounts;
    };

const EMPTY_COUNTS: RedactionCounts = {
  names: 0,
  emails: 0,
  phones: 0,
  addresses: 0,
};

const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/gi;

const PHONE_PATTERNS: readonly RegExp[] = [
  /\+\d{1,3}[\s.-]*\(\d{1,4}\)[\s.-]*\d{3,4}[\s.-]*\d{4}(?:\s*(?:ext\.?|x|extension)\s*\d{1,6})?/gi,
  /\+\d{1,3}(?:[\s.-]+\d{1,4}){2,5}(?:\s*(?:ext\.?|x|extension)\s*\d{1,6})?/gi,
  /\(\d{3}\)[\s.-]?\d{3}[\s.-]?\d{4}(?:\s*(?:ext\.?|x|extension)\s*\d{1,6})?/g,
  /\b\d{3}[\s.-]\d{3}[\s.-]\d{4}(?:\s*(?:ext\.?|x|extension)\s*\d{1,6})?\b/g,
  /\b\d{10}(?:\s*(?:ext\.?|x|extension)\s*\d{1,6})?\b/g,
  /\b\d{3}[-.]\d{4}\b/g,
];

const STREET_SUFFIX =
  "Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Place|Pl|Way|Parkway|Pkwy|Plaza|Plz";
const UNIT = String.raw`(?:\s+(?:Apt|Unit|Suite|Ste|#)\s*[A-Za-z0-9]{1,6})?`;
const DIRECTIONAL = String.raw`(?:(?:North|South|East|West|N|S|E|W)\.?\s+)`;

const STREET_ADDRESS_PATTERNS: readonly RegExp[] = [
  new RegExp(
    String.raw`\b\d{1,6}\s+${DIRECTIONAL}?\d{1,4}(?:st|nd|rd|th)\s+(?:${STREET_SUFFIX})\b\.?${UNIT}`,
    "g",
  ),
  new RegExp(
    String.raw`\b\d{1,6}\s+${DIRECTIONAL}[A-Z][A-Za-z]{1,24}(?:\s+[A-Z][A-Za-z]{1,24}){0,2}\s+(?:${STREET_SUFFIX})\b\.?(?:\s+(?:North|South|East|West))?${UNIT}`,
    "g",
  ),
  new RegExp(
    String.raw`\b\d{1,6}\s+[A-Z][A-Za-z]{1,24}(?:\s+[A-Z][A-Za-z]{1,24}){0,2}\s+(?:${STREET_SUFFIX})\b\.?(?:\s+(?:North|South|East|West))?${UNIT}`,
    "g",
  ),
];

const ZIP_PATTERN = /\b(?:ZIP|zip|Zip)(?:\s+code)?(?:\s+is)?[:\s]+(\d{5}(?:-\d{4})?)\b/g;

/** Bounded, Unicode-aware name token. ASCII \\b is not used. */
const NAME_TOKEN = /(?<![\p{L}'’-])[\p{L}'’-]{1,40}(?![\p{L}'’-])/gu;

const POSSESSORS = new Set(["my", "his", "her", "their", "our"]);
const FIRST_PERSON = new Set(["me", "i"]);
const TITLES = new Set(["dr", "mr", "mrs", "ms", "mx"]);
const GREETINGS = new Set(["hi", "hey", "hello", "dear"]);
const ACTION_CUES = new Set(["taking", "surprise", "treat", "celebrating"]);

/** Hoisted once. Not rebuilt per call. */
const RELATIONS = new Set([
  "friend",
  "girlfriend",
  "boyfriend",
  "partner",
  "spouse",
  "husband",
  "wife",
  "brother",
  "sister",
  "cousin",
  "mom",
  "dad",
  "mother",
  "father",
  "son",
  "daughter",
  "aunt",
  "uncle",
  "nephew",
  "niece",
  "colleague",
  "coworker",
  "boss",
  "manager",
  "fiance",
  "fiancee",
  "fiancé",
  "fiancée",
  "bf",
  "gf",
  "date",
  "roommate",
  "housemate",
  "flatmate",
  "sister-in-law",
  "brother-in-law",
  "mother-in-law",
  "father-in-law",
  "stepmother",
  "stepfather",
  "stepson",
  "stepdaughter",
  "step-sister",
  "step-brother",
]);

const FUNCTION_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "is",
  "are",
  "in",
  "at",
  "on",
  "for",
  "to",
  "of",
  "out",
  "with",
  "w",
  "n",
  "my",
  "his",
  "her",
  "their",
  "our",
  "me",
  "i",
  "named",
  "name",
]);

interface Tok {
  raw: string;
  start: number;
  end: number;
  folded: string;
}

interface Span {
  start: number;
  end: number;
}

interface NameRun {
  endIndex: number;
  start: number;
  end: number;
}

function codePointLength(value: string): number {
  return [...value].length;
}

function isProperShape(token: string): boolean {
  const first = token[0];
  return first !== undefined && /\p{Lu}/u.test(first);
}

function stripPossessiveRaw(token: string): { base: string; possessive: boolean } {
  if (token.length > 2 && /['’]s$/u.test(token)) {
    return { base: token.slice(0, -2), possessive: true };
  }
  return { base: token, possessive: false };
}

function tokenize(text: string): Tok[] {
  const tokens: Tok[] = [];
  NAME_TOKEN.lastIndex = 0;
  for (const match of text.matchAll(NAME_TOKEN)) {
    if (match.index === undefined) {
      continue;
    }
    tokens.push({
      raw: match[0],
      start: match.index,
      end: match.index + match[0].length,
      folded: foldedNameKey(match[0]),
    });
  }
  return tokens;
}

function between(text: string, left: Tok, right: Tok): string {
  return text.slice(left.end, right.start);
}

function isListConnector(gap: string): boolean {
  return (
    /^\s*(?:,\s*)?(?:and|&|&amp;|n|\+|\/)\s*$/i.test(gap) ||
    /^\s*,\s*(?:and|&|&amp;)?\s*$/i.test(gap) ||
    /^\s*\/\s*$/.test(gap)
  );
}

function isHtmlAmpersand(text: string, token: Tok): boolean {
  return token.folded === "amp" && text[token.start - 1] === "&" && text[token.end] === ";";
}

function isConnectorToken(text: string, token: Tok): boolean {
  return (
    token.folded === "and" ||
    token.folded === "n" ||
    token.folded === "or" ||
    isHtmlAmpersand(text, token)
  );
}

function alreadyRedacted(text: string, token: Tok): boolean {
  return text[token.start - 1] === "[" && text[token.end] === "]";
}

function isWeakWithGap(gap: string): boolean {
  return /^\s*\/?\s*$/.test(gap);
}

function hasAtHandle(text: string, token: Tok): boolean {
  let i = token.start - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === undefined || ch === " " || ch === "\n" || ch === "\t") {
      i -= 1;
      continue;
    }
    return ch === "@";
  }
  return false;
}

function atHandleStart(text: string, token: Tok): number {
  let i = token.start - 1;
  while (i >= 0 && (text[i] === " " || text[i] === "\n" || text[i] === "\t")) {
    i -= 1;
  }
  return text[i] === "@" ? i : token.start;
}

function precededByWeakWith(tokens: Tok[], index: number, text: string): boolean {
  if (index <= 0) {
    return false;
  }
  const prev = tokens[index - 1];
  return (prev.folded === "with" || prev.folded === "w") && isWeakWithGap(between(text, prev, tokens[index]));
}

function acceptsName(
  text: string,
  token: Tok,
  strength: "strong" | "weak",
  requireCapital = false,
): boolean {
  if (alreadyRedacted(text, token)) {
    return false;
  }
  const stripped = stripPossessiveRaw(token.raw);
  const folded = foldedNameKey(stripped.base);
  if (
    FUNCTION_WORDS.has(folded) ||
    RELATIONS.has(folded) ||
    TITLES.has(folded) ||
    GREETINGS.has(folded) ||
    ACTION_CUES.has(folded)
  ) {
    return false;
  }
  if (strength === "weak" && isPlaceTerm(stripped.base)) {
    return false;
  }
  if (requireCapital && !isProperShape(stripped.base)) {
    return false;
  }
  if (strength === "weak") {
    return isGivenName(stripped.base);
  }
  if (isProperShape(stripped.base)) {
    return true;
  }
  return isGivenName(stripped.base);
}

function addSpan(spans: Span[], start: number, end: number): void {
  if (end > start) {
    spans.push({ start, end });
  }
}

function nextNonConnector(text: string, tokens: Tok[], index: number): number {
  let cursor = index;
  while (cursor < tokens.length && isConnectorToken(text, tokens[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function consumeNameRun(
  text: string,
  tokens: Tok[],
  folded: readonly string[],
  index: number,
  strength: "strong" | "weak",
  requireCapital = false,
): NameRun | null {
  const token = tokens[index];
  if (!token || !acceptsName(text, token, strength, requireCapital)) {
    return null;
  }
  if (strength === "weak" && placePhraseLength(folded, index) > 0) {
    return null;
  }
  let last = index;
  for (let offset = 1; offset <= 2 && index + offset < tokens.length; offset += 1) {
    const prev = tokens[index + offset - 1];
    const next = tokens[index + offset];
    if (!/^\s+$/.test(between(text, prev, next))) {
      break;
    }
    if (alreadyRedacted(text, next)) {
      break;
    }
    if (strength === "weak" && placePhraseLength(folded, index + offset) > 0) {
      break;
    }
    if (isPlaceTerm(next.raw) && strength === "weak") {
      break;
    }
    if (!isProperShape(next.raw) && !isGivenName(next.raw)) {
      break;
    }
    if (FUNCTION_WORDS.has(next.folded) || RELATIONS.has(next.folded) || TITLES.has(next.folded)) {
      break;
    }
    last = index + offset;
  }
  const first = tokens[index];
  const final = tokens[last];
  const stripped = stripPossessiveRaw(final.raw);
  const end = stripped.possessive ? final.start + stripped.base.length : final.end;
  return { endIndex: last, start: first.start, end };
}

function collectListMembers(
  text: string,
  tokens: Tok[],
  folded: readonly string[],
  startIndex: number,
  strength: "strong" | "weak",
  requireCapital = false,
): NameRun[] {
  if (strength === "weak" && placePhraseLength(folded, startIndex) > 0) {
    return [];
  }
  const first = consumeNameRun(text, tokens, folded, startIndex, strength, requireCapital);
  if (!first) {
    return [];
  }
  const members: NameRun[] = [first];
  let prev = first.endIndex;
  let cursor = first.endIndex + 1;
  while (cursor < tokens.length) {
    cursor = nextNonConnector(text, tokens, cursor);
    if (cursor >= tokens.length) {
      break;
    }
    const gap = between(text, tokens[prev], tokens[cursor]);
    const skippedConnector = cursor > prev + 1;
    if (!skippedConnector && !isListConnector(gap)) {
      break;
    }
    if (FIRST_PERSON.has(tokens[cursor].folded)) {
      break;
    }
    if (strength === "weak" && placePhraseLength(folded, cursor) > 0) {
      break;
    }
    const next = consumeNameRun(text, tokens, folded, cursor, strength, requireCapital);
    if (!next) {
      break;
    }
    members.push(next);
    prev = next.endIndex;
    cursor = next.endIndex + 1;
  }
  return members;
}

function collectNames(text: string): Span[] {
  const tokens = tokenize(text);
  const folded = tokens.map((token) => token.folded);
  const spans: Span[] = [];
  const used = new Set<number>();

  const occupySpan = (start: number, end: number): void => {
    for (let i = 0; i < tokens.length; i += 1) {
      if (tokens[i].start < end && tokens[i].end > start) {
        used.add(i);
      }
    }
  };

  const markRun = (run: NameRun | null): boolean => {
    if (!run) {
      return false;
    }
    addSpan(spans, run.start, run.end);
    occupySpan(run.start, run.end);
    return true;
  };

  const markMembers = (members: NameRun[], merged: boolean): boolean => {
    if (members.length === 0) {
      return false;
    }
    if (merged) {
      const start = members[0].start;
      const end = members[members.length - 1].end;
      addSpan(spans, start, end);
      occupySpan(start, end);
      return true;
    }
    for (const member of members) {
      addSpan(spans, member.start, member.end);
      occupySpan(member.start, member.end);
    }
    return true;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (alreadyRedacted(text, tok) || used.has(i)) {
      continue;
    }

    if (hasAtHandle(text, tok) && (isGivenName(tok.raw) || isProperShape(tok.raw))) {
      addSpan(spans, atHandleStart(text, tok), tok.end);
      used.add(i);
      continue;
    }

    if (TITLES.has(tok.folded) && i + 1 < tokens.length && /^\.?\s+$/.test(between(text, tok, tokens[i + 1]))) {
      const run = consumeNameRun(text, tokens, folded, i + 1, "strong");
      if (run) {
        addSpan(spans, tok.start, run.end);
        occupySpan(tok.start, run.end);
        continue;
      }
    }

    if (GREETINGS.has(tok.folded) && i + 1 < tokens.length) {
      markRun(consumeNameRun(text, tokens, folded, i + 1, "strong"));
      continue;
    }

    if (tok.folded === "named" && i + 1 < tokens.length) {
      markRun(consumeNameRun(text, tokens, folded, i + 1, "strong"));
      continue;
    }

    if (ACTION_CUES.has(tok.folded)) {
      const after = i + 1 < tokens.length && tokens[i + 1].folded === "for" ? i + 2 : i + 1;
      markRun(consumeNameRun(text, tokens, folded, after, "strong"));
      continue;
    }

    if (tok.folded === "for" && i + 1 < tokens.length) {
      if (FIRST_PERSON.has(tokens[i + 1].folded)) {
        const nameAt = nextNonConnector(text, tokens, i + 2);
        if (nameAt < tokens.length) {
          markMembers(collectListMembers(text, tokens, folded, nameAt, "strong"), false);
          continue;
        }
      } else {
        const run = consumeNameRun(text, tokens, folded, i + 1, "strong");
        if (run) {
          const afterName = nextNonConnector(text, tokens, run.endIndex + 1);
          const gapToAfter = afterName < tokens.length ? between(text, tokens[run.endIndex], tokens[afterName]) : "";
          if (
            afterName < tokens.length &&
            FIRST_PERSON.has(tokens[afterName].folded) &&
            (isListConnector(gapToAfter) || afterName > run.endIndex + 1)
          ) {
            markRun(run);
            continue;
          }
        }
      }
    }

    if (POSSESSORS.has(tok.folded)) {
      if (i + 3 < tokens.length && tokens[i + 1].folded === "name" && tokens[i + 2].folded === "is") {
        markRun(consumeNameRun(text, tokens, folded, i + 3, "strong"));
        continue;
      }
      let relationAt = -1;
      for (let j = i + 1; j <= i + 3 && j < tokens.length; j += 1) {
        if (RELATIONS.has(tokens[j].folded)) {
          relationAt = j;
          break;
        }
        if (
          FUNCTION_WORDS.has(tokens[j].folded) ||
          POSSESSORS.has(tokens[j].folded) ||
          FIRST_PERSON.has(tokens[j].folded)
        ) {
          break;
        }
      }
      if (relationAt >= 0 && relationAt + 1 < tokens.length) {
        markRun(consumeNameRun(text, tokens, folded, relationAt + 1, "strong"));
        continue;
      }
    }

    if (RELATIONS.has(tok.folded) && (i === 0 || !POSSESSORS.has(tokens[i - 1]?.folded))) {
      markRun(consumeNameRun(text, tokens, folded, i + 1, "strong"));
    }

    const stripped = stripPossessiveRaw(tok.raw);
    const eventPossessive = stripped.possessive || /^['’]s(?:\s|$)/.test(text.slice(tok.end));
    if (
      eventPossessive &&
      !precededByWeakWith(tokens, i, text) &&
      (isProperShape(stripped.base) || isGivenName(stripped.base)) &&
      !isPlaceTerm(stripped.base)
    ) {
      const rest = text.slice(stripped.possessive ? tok.end : tok.end + 2);
      const event = rest.match(/^\s+([\p{L}'’-]{1,40}|\d{1,4}(?:st|nd|rd|th)?)/u);
      if (event) {
        const eventFolded = foldedNameKey(event[1]);
        const eventIsNoun =
          /^\d/.test(event[1]) ||
          (event[1][0] !== undefined && event[1][0] === event[1][0].toLowerCase() && !/\p{Lu}/u.test(event[1][0]));
        if (
          eventIsNoun &&
          !FUNCTION_WORDS.has(eventFolded) &&
          !RELATIONS.has(eventFolded) &&
          !POSSESSORS.has(eventFolded)
        ) {
          addSpan(spans, tok.start, tok.start + stripped.base.length);
          used.add(i);
          continue;
        }
      }
    }

    if ((tok.folded === "with" || tok.folded === "w") && i + 1 < tokens.length && isWeakWithGap(between(text, tok, tokens[i + 1]))) {
      const next = tokens[i + 1];
      if (TITLES.has(next.folded) || POSSESSORS.has(next.folded) || RELATIONS.has(next.folded)) {
        continue;
      }
      if (/['’]s/.test(next.raw)) {
        continue;
      }
      if (placePhraseLength(folded, i + 1) > 0) {
        continue;
      }
      markMembers(collectListMembers(text, tokens, folded, i + 1, "weak", true), true);
      continue;
    }

    if (FIRST_PERSON.has(tok.folded)) {
      const nameAt = nextNonConnector(text, tokens, i + 1);
      if (
        nameAt < tokens.length &&
        nameAt > i &&
        (isConnectorToken(text, tokens[i + 1]) || isListConnector(between(text, tok, tokens[nameAt])))
      ) {
        markMembers(collectListMembers(text, tokens, folded, nameAt, "weak"), false);
        continue;
      }
    }

    if (
      i + 2 < tokens.length &&
      isConnectorToken(text, tokens[i + 1]) &&
      FIRST_PERSON.has(tokens[i + 2].folded) &&
      acceptsName(text, tok, "strong")
    ) {
      addSpan(spans, tok.start, tok.end);
      used.add(i);
      continue;
    }

    if (
      i + 4 < tokens.length &&
      isConnectorToken(text, tokens[i + 1]) &&
      acceptsName(text, tokens[i + 2], "strong") &&
      isConnectorToken(text, tokens[i + 3]) &&
      FIRST_PERSON.has(tokens[i + 4].folded) &&
      acceptsName(text, tok, "strong")
    ) {
      addSpan(spans, tok.start, tok.end);
      addSpan(spans, tokens[i + 2].start, tokens[i + 2].end);
      used.add(i);
      used.add(i + 2);
      continue;
    }

    if (
      i + 2 < tokens.length &&
      isConnectorToken(text, tokens[i + 1]) &&
      (tokens[i + 2].folded === "his" || tokens[i + 2].folded === "her") &&
      acceptsName(text, tok, "strong")
    ) {
      addSpan(spans, tok.start, tok.end);
      used.add(i);
      continue;
    }

    if (i + 2 < tokens.length && POSSESSORS.has(tokens[i + 1].folded) && RELATIONS.has(tokens[i + 2].folded)) {
      const gap = between(text, tok, tokens[i + 1]);
      if (/^\s*\(\s*$/.test(gap) && (isGivenName(tok.raw) || isProperShape(tok.raw))) {
        addSpan(spans, tok.start, tok.end);
        used.add(i);
      }
    }
  }

  for (let i = 0; i < tokens.length; i += 1) {
    if (used.has(i) || alreadyRedacted(text, tokens[i]) || placePhraseLength(folded, i) > 0) {
      continue;
    }
    if (!isGivenName(tokens[i].raw)) {
      continue;
    }
    const members = collectListMembers(text, tokens, folded, i, "weak");
    if (members.length > 1) {
      markMembers(members, false);
    }
  }

  return spans;
}

function mergeSpans(spans: Span[]): Span[] {
  if (spans.length === 0) {
    return [];
  }
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Span[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

function applySpans(text: string, spans: Span[]): { text: string; count: number } {
  const merged = mergeSpans(spans);
  let result = text;
  for (let i = merged.length - 1; i >= 0; i -= 1) {
    result = `${result.slice(0, merged[i].start)}[NAME]${result.slice(merged[i].end)}`;
  }
  return { text: result, count: merged.length };
}

function replaceAll(source: string, pattern: RegExp, replacement: string, onHit: () => void): string {
  pattern.lastIndex = 0;
  return source.replace(pattern, () => {
    onHit();
    return replacement;
  });
}

/** Uncapped core used by tests to measure scanner cost without the length gate. */
export function redactTextUncapped(input: string): { text: string; counts: RedactionCounts } {
  let result = input;
  const counts = { names: 0, emails: 0, phones: 0, addresses: 0 };

  result = replaceAll(result, EMAIL_PATTERN, "[EMAIL]", () => {
    counts.emails += 1;
  });
  for (const pattern of PHONE_PATTERNS) {
    result = replaceAll(result, pattern, "[PHONE]", () => {
      counts.phones += 1;
    });
  }
  for (const pattern of STREET_ADDRESS_PATTERNS) {
    result = replaceAll(result, pattern, "[ADDRESS]", () => {
      counts.addresses += 1;
    });
  }
  result = result.replace(ZIP_PATTERN, (full, zip: string) => {
    counts.addresses += 1;
    return full.replace(zip, "[ZIP]");
  });

  const names = applySpans(result, collectNames(result));
  return { text: names.text, counts: { ...counts, names: names.count } };
}

export function redact(text: unknown): RedactionResult {
  try {
    if (typeof text === "object" && text !== null) {
      const walked = redactValue(text);
      const asText = typeof walked === "string" ? walked : JSON.stringify(walked);
      return { ok: true, text: asText ?? "", counts: EMPTY_COUNTS };
    }
    const input = typeof text === "string" ? text : String(text ?? "");
    if (codePointLength(input) > MAX_INPUT_CHARS) {
      return { ok: false, error: "too_long", text: "", counts: EMPTY_COUNTS };
    }
    const redacted = redactTextUncapped(input);
    return { ok: true, text: redacted.text, counts: redacted.counts };
  } catch {
    return { ok: false, error: "internal", text: "", counts: EMPTY_COUNTS };
  }
}

const MAX_DEPTH = 32;

export function redactValue(value: unknown): unknown {
  const walk = (node: unknown, depth: number, ancestors: readonly object[]): unknown => {
    if (depth > MAX_DEPTH) {
      return "[REDACTION_ERROR]";
    }
    if (node === null || node === undefined) {
      return node;
    }
    const type = typeof node;
    if (type === "function" || type === "symbol") {
      return undefined;
    }
    if (type === "string") {
      const result = redact(node);
      return result.ok ? result.text : "";
    }
    if (type === "number" || type === "boolean") {
      return node;
    }
    if (type !== "object") {
      return undefined;
    }
    if (ancestors.includes(node)) {
      return "[REDACTION_ERROR: circular reference]";
    }
    if (node instanceof Date) {
      return node.toISOString();
    }
    if (node instanceof Map) {
      return [...node.entries()].map(([key, nested]) => [
        walk(key, depth + 1, ancestors),
        walk(nested, depth + 1, ancestors),
      ]);
    }
    if (node instanceof Set) {
      return [...node.values()].map((nested) => walk(nested, depth + 1, ancestors));
    }
    if (node instanceof Error) {
      const next = [...ancestors, node];
      return {
        name: walk(node.name, depth + 1, next),
        message: walk(node.message, depth + 1, next),
      };
    }
    const nextAncestors = [...ancestors, node];
    if (Array.isArray(node)) {
      return node.map((item) => walk(item, depth + 1, nextAncestors));
    }
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(node)) {
      const keyResult = typeof key === "string" ? redact(key) : null;
      const safeKey = keyResult ? (keyResult.ok ? keyResult.text : "") : String(key);
      output[safeKey] = walk(nested, depth + 1, nextAncestors);
    }
    return output;
  };

  try {
    return walk(value, 0, []);
  } catch {
    return "[REDACTION_ERROR]";
  }
}

export function redactForStorage(text: unknown): RedactionResult {
  return redact(text);
}

export function redactForTrace(text: unknown): RedactionResult {
  return redact(text);
}

export { GIVEN_NAME_COUNT } from "./data/lookup";
