/**
 * PII redaction for NightCap.
 *
 * Deterministic, no network, no LLM. This is the only choke point later code
 * should call before a database write or a Datadog span attribute.
 *
 * Input cap: 4096 characters. Longer input fails closed with
 * `[REDACTION_ERROR: input exceeds 4KB limit]` so adversarial strings never
 * reach the regexes.
 *
 * Markers actually emitted: [NAME], [EMAIL], [PHONE], [ADDRESS], [ZIP],
 * and [REDACTION_ERROR] / [REDACTION_ERROR: ...] on failure. ZIP matches are
 * counted under `counts.addresses`.
 *
 * Known limits:
 * - Context-free given names ("Sarah went there") are not redacted. A bare
 *   capitalized word is too often a venue, neighborhood, or dish.
 * - CJK names have no uppercase and are not matched by the name-token rule.
 * - Cyrillic and other cased scripts work when they sit after a person cue.
 * - A small NYC gazetteer plus possessive-'s skipping keeps "with Chelsea"
 *   and "Joe's Pizza" intact; an unknown venue that looks like a person name
 *   after "with" can still be redacted.
 * - 7-digit local phones are redacted; bare 5-digit numbers are not ZIPs
 *   unless a "zip" cue is present.
 */

const MAX_INPUT_LENGTH = 4096;

export interface RedactionCounts {
  readonly names: number;
  readonly emails: number;
  readonly phones: number;
  readonly addresses: number;
}

export interface RedactionResult {
  readonly text: string;
  readonly counts: RedactionCounts;
}

const EMPTY_COUNTS: RedactionCounts = {
  names: 0,
  emails: 0,
  phones: 0,
  addresses: 0,
};

/** Bounded local/domain/TLD lengths. No nested optional repeats. */
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/gi;

/**
 * Phones consume the country code and extension so nothing identifiable is
 * left over. Quantifiers are bounded; no overlapping `\d*\w*` runs.
 */
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

/**
 * Street addresses. Suffixes stay case-sensitive and end with `\b` so
 * "drinks" cannot match `Dr`. No `/i`, no overlapping `\d*\w*`.
 */
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
    String.raw`\b\d{1,6}\s+[A-Z][A-Za-z]{1,24}(?:\s+[A-Za-z]{1,24}){0,2}\s+(?:${STREET_SUFFIX})\b\.?(?:\s+(?:North|South|East|West))?${UNIT}`,
    "g",
  ),
];

/** ZIP only with an explicit cue. Bare neighborhood ZIPs stay (planner signal). */
const ZIP_PATTERN = /\b(?:ZIP|zip|Zip)(?:\s+code)?(?:\s+is)?[:\s]+(\d{5}(?:-\d{4})?)\b/g;

const RELATIONS =
  "friend|girlfriend|boyfriend|partner|spouse|husband|wife|brother|sister|cousin|mom|dad|mother|father|son|daughter|aunt|uncle|nephew|niece|colleague|coworker|boss|manager|fianc[eé]e?|bf|gf|date";

const TITLES = "Dr|Mr|Mrs|Ms|Mx";

const NAME_PART = /^\p{Lu}[\p{L}'’-]*$/u;
const LOWER_NAME_PART = /^[\p{Ll}][\p{L}'’-]*$/u;
const SINGLE_NAME = String.raw`[\p{L}'’-]+`;

const STOP_WORDS = new Set([
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
  "after",
  "before",
  "with",
  "my",
  "his",
  "her",
  "their",
  "our",
  "me",
  "i",
  "tonight",
  "today",
  "tomorrow",
  "night",
  "later",
  "now",
  "then",
  "near",
  "under",
  "over",
  "from",
  "visiting",
  "wants",
  "loves",
  "need",
  "needs",
  "birthday",
  "anniversary",
  "party",
  "engagement",
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
]);

/**
 * NYC neighborhoods, landmarks, and venues that follow "with" in real requests.
 * Lowercase, longest phrases first when scanning.
 */
const GAZETTEER = [
  "washington square park",
  "madison square garden",
  "lower east side",
  "jackson heights",
  "murray hill",
  "little italy",
  "union square",
  "east village",
  "west village",
  "greenwich village",
  "soho house",
  "joe's pizza",
  "via carota",
  "hi-collar",
  "the bowery",
  "houston st",
  "central park",
  "times square",
  "prospect park",
  "battery park",
  "high line",
  "chelsea",
  "nolita",
  "soho",
  "tribeca",
  "brooklyn",
  "manhattan",
  "williamsburg",
  "astoria",
  "bushwick",
  "flushing",
  "harlem",
  "bowery",
  "houston",
  "village",
  "queens",
  "bronx",
  "midtown",
  "downtown",
  "chinatown",
  "nolita",
  "dante",
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "bar",
  "restaurant",
  "pizza",
  "brunch",
  "house",
  "park",
  "garden",
  "italy",
  "heights",
  "hill",
  "square",
];

const GAZETTEER_SET = new Set(GAZETTEER);

interface Span {
  start: number;
  end: number;
}

function isNamePart(token: string, allowLowercase: boolean): boolean {
  if (NAME_PART.test(token)) {
    return token.length >= 1;
  }
  return allowLowercase && token.length >= 2 && LOWER_NAME_PART.test(token);
}

function stripPossessive(token: string): { base: string; possessive: boolean } {
  const possessive = /['’]s$/u.exec(token);
  if (!possessive || token.length <= 2) {
    return { base: token, possessive: false };
  }
  const base = token.slice(0, -possessive[0].length);
  if (base.length === 0) {
    return { base: token, possessive: false };
  }
  return { base, possessive: true };
}

function takeNameTokens(
  captured: string,
  allowLowercase: boolean,
): { raw: string; endInCapture: number; possessive: boolean } | null {
  const tokens: string[] = [];
  let cursor = 0;
  let possessive = false;

  while (tokens.length < 3 && cursor < captured.length) {
    const rest = captured.slice(cursor);
    const space = rest.match(/^\s+/);
    const tokenOffset = space ? space[0].length : 0;
    const match = rest.slice(tokenOffset).match(/^[\p{L}'’-]+/u);
    if (!match) {
      break;
    }
    const stripped = stripPossessive(match[0]);
    if (STOP_WORDS.has(stripped.base.toLowerCase())) {
      break;
    }
    if (stripped.base.startsWith("[") && stripped.base.endsWith("]")) {
      break;
    }
    if (!isNamePart(stripped.base, allowLowercase && tokens.length === 0)) {
      break;
    }
    tokens.push(stripped.base);
    cursor += tokenOffset + stripped.base.length;
    if (stripped.possessive) {
      possessive = true;
      break;
    }
  }

  if (tokens.length === 0) {
    return null;
  }
  return { raw: tokens.join(" "), endInCapture: cursor, possessive };
}

function gazetteerAt(text: string, index: number): boolean {
  const slice = text.slice(index).toLowerCase();
  for (const place of GAZETTEER) {
    if (!slice.startsWith(place)) {
      continue;
    }
    const next = slice[place.length];
    if (next === undefined || !/\p{L}/u.test(next)) {
      return true;
    }
  }
  return false;
}

function isGazetteerName(name: string): boolean {
  return GAZETTEER_SET.has(name.toLowerCase());
}

function isPossessiveVenue(text: string, nameEnd: number): boolean {
  const rest = text.slice(nameEnd);
  if (!rest.startsWith("'s") && !rest.startsWith("’s")) {
    return false;
  }
  return !/^[’']s\s+(?:birthday|anniversary|party|engagement|\d{1,3}(?:st|nd|rd|th))\b/i.test(rest);
}

function addSpan(spans: Span[], start: number, end: number): void {
  if (end <= start) {
    return;
  }
  spans.push({ start, end });
}

function takeNameList(
  source: string,
  allowLowercase: boolean,
): { raw: string; endInCapture: number; possessive: boolean } | null {
  const first = takeNameTokens(source, allowLowercase);
  if (!first) {
    return null;
  }
  let end = first.endInCapture;
  let possessive = first.possessive;
  if (possessive) {
    return first;
  }
  while (end < source.length) {
    const sep = source.slice(end).match(/^\s*(?:,\s*)?(?:and|&|&amp;)\s+/i) ?? source.slice(end).match(/^\s*,\s+/);
    if (!sep) {
      break;
    }
    const next = takeNameTokens(source.slice(end + sep[0].length), allowLowercase);
    if (!next) {
      break;
    }
    end = end + sep[0].length + next.raw.length;
    possessive = next.possessive;
    if (possessive) {
      break;
    }
  }
  return { raw: source.slice(0, end), endInCapture: end, possessive };
}

function namesAfterCue(
  text: string,
  cueEnd: number,
  allowLowercase: boolean,
  list: boolean,
): { start: number; end: number; possessive: boolean } | null {
  const gap = text.slice(cueEnd).match(/^\s*,?\s+/);
  if (!gap) {
    return null;
  }
  const start = cueEnd + gap[0].length;
  const taken = list
    ? takeNameList(text.slice(start), allowLowercase)
    : takeNameTokens(text.slice(start), allowLowercase);
  if (!taken) {
    return null;
  }
  return { start, end: start + taken.raw.length, possessive: taken.possessive };
}

function collectAfterCue(
  text: string,
  pattern: RegExp,
  spans: Span[],
  options: { allowLowercase: boolean; skipGazetteer: boolean; list?: boolean },
): void {
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) {
      continue;
    }
    const found = namesAfterCue(text, match.index + match[0].length, options.allowLowercase, options.list === true);
    if (!found) {
      continue;
    }
    if (options.skipGazetteer && (gazetteerAt(text, found.start) || isGazetteerName(text.slice(found.start, found.end)))) {
      continue;
    }
    if (options.skipGazetteer && (found.possessive || isPossessiveVenue(text, found.end))) {
      continue;
    }
    addSpan(spans, found.start, found.end);
  }
}

function collectNames(text: string): Span[] {
  const spans: Span[] = [];
  const cue = "giu";

  // Relation + optional comma + name. Strong cue: lowercase allowed.
  // Months/weekdays after a relation stay names (do not gazetteer-skip).
  collectAfterCue(
    text,
    new RegExp(String.raw`\b(?:my|his|her|their|our)\s+(?:${RELATIONS})`, cue),
    spans,
    { allowLowercase: true, skipGazetteer: false },
  );

  collectAfterCue(
    text,
    new RegExp(String.raw`\bfor\s+me\s+and`, cue),
    spans,
    { allowLowercase: true, skipGazetteer: false },
  );

  const relationWords = new Set(RELATIONS.split("|").map((word) => word.normalize("NFKD").toLowerCase()));
  relationWords.add("fiancé");
  relationWords.add("fiance");
  relationWords.add("fiancée");
  relationWords.add("fiancee");

  for (const match of text.matchAll(new RegExp(String.raw`\bfor\s+(${SINGLE_NAME})\s+and\s+(?:me|i)\b`, `${cue}d`))) {
    if (match.index === undefined || !match[1]) {
      continue;
    }
    if (relationWords.has(match[1].toLowerCase())) {
      continue;
    }
    const taken = takeNameTokens(match[1], true);
    if (!taken) {
      continue;
    }
    const start = match.indices?.[1]?.[0] ?? match.index + match[0].indexOf(match[1]);
    addSpan(spans, start, start + taken.raw.length);
  }

  for (const match of text.matchAll(new RegExp(String.raw`\b(${SINGLE_NAME})\s+and\s+(?:me|i)\b`, `${cue}d`))) {
    if (match.index === undefined || !match[1]) {
      continue;
    }
    if (relationWords.has(match[1].toLowerCase())) {
      continue;
    }
    const taken = takeNameTokens(match[1], true);
    if (!taken) {
      continue;
    }
    const start = match.indices?.[1]?.[0] ?? match.index;
    addSpan(spans, start, start + taken.raw.length);
  }

  for (const match of text.matchAll(new RegExp(String.raw`\b(${SINGLE_NAME})\s+and\s+(?:his|her)\b`, `${cue}d`))) {
    if (match.index === undefined || !match[1]) {
      continue;
    }
    const taken = takeNameTokens(match[1], false);
    if (!taken || isGazetteerName(taken.raw)) {
      continue;
    }
    const start = match.indices?.[1]?.[0] ?? match.index;
    addSpan(spans, start, start + taken.raw.length);
  }

  for (const match of text.matchAll(
    new RegExp(
      String.raw`\b(${SINGLE_NAME})['’]s\s+(?:birthday|anniversary|party|engagement|\d{1,3}(?:st|nd|rd|th))\b`,
      `${cue}d`,
    ),
  )) {
    if (match.index === undefined || !match[1]) {
      continue;
    }
    const taken = takeNameTokens(match[1], false);
    if (!taken) {
      continue;
    }
    addSpan(spans, match.index, match.index + taken.raw.length);
  }

  collectAfterCue(
    text,
    new RegExp(String.raw`\b(?:taking|surprise|treat)`, cue),
    spans,
    { allowLowercase: false, skipGazetteer: true },
  );

  for (const match of text.matchAll(new RegExp(String.raw`\b(?:${TITLES})\.?\s+(${SINGLE_NAME}(?:\s+${SINGLE_NAME}){0,2})`, `${cue}d`))) {
    if (match.index === undefined || !match[1]) {
      continue;
    }
    const taken = takeNameTokens(match[1], false);
    if (!taken) {
      continue;
    }
    addSpan(spans, match.index, match.index + match[0].length - (match[1].length - taken.raw.length));
  }

  for (const match of text.matchAll(
    new RegExp(
      String.raw`\b(${SINGLE_NAME})\s*,\s*(${SINGLE_NAME})\s*,\s*(?:and|&|&amp;)\s+(${SINGLE_NAME})\b`,
      `${cue}d`,
    ),
  )) {
    if (match.index === undefined) {
      continue;
    }
    const parts = [match[1], match[2], match[3]];
    if (parts.every((part) => part && takeNameTokens(part, false) && !isGazetteerName(part))) {
      addSpan(spans, match.index, match.index + match[0].length);
    }
  }

  collectAfterCue(
    text,
    new RegExp(String.raw`\bwith`, cue),
    spans,
    { allowLowercase: false, skipGazetteer: true, list: true },
  );

  collectAfterCue(
    text,
    new RegExp(String.raw`\b(?:hi|hey|hello|dear)`, cue),
    spans,
    { allowLowercase: false, skipGazetteer: true },
  );
  collectAfterCue(
    text,
    new RegExp(String.raw`\bnamed`, cue),
    spans,
    { allowLowercase: true, skipGazetteer: true },
  );

  return spans;
}

function isNameConnector(between: string): boolean {
  return /^\s*(?:,\s*)?(?:and|&|&amp;)\s*$/i.test(between);
}

function mergeSpans(spans: Span[], text: string): Span[] {
  if (spans.length === 0) {
    return [];
  }
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Span[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    const between = text.slice(last.end, current.start);
    if (current.start <= last.end || isNameConnector(between)) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

function applySpans(text: string, spans: Span[]): { text: string; count: number } {
  const merged = mergeSpans(spans, text);
  if (merged.length === 0) {
    return { text, count: 0 };
  }
  let result = text;
  for (let i = merged.length - 1; i >= 0; i -= 1) {
    const { start, end } = merged[i];
    result = `${result.slice(0, start)}[NAME]${result.slice(end)}`;
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

/**
 * Redact PII from free text or a coerced primitive.
 * Never throws. Oversized input and internal errors fail closed.
 */
export function redact(text: unknown): RedactionResult {
  try {
    const input = typeof text === "string" ? text : String(text ?? "");
    if (input.length > MAX_INPUT_LENGTH) {
      return {
        text: "[REDACTION_ERROR: input exceeds 4KB limit]",
        counts: EMPTY_COUNTS,
      };
    }

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

    result = result.replace(ZIP_PATTERN, (_full, zip: string) => {
      counts.addresses += 1;
      return _full.replace(zip, "[ZIP]");
    });

    const names = applySpans(result, collectNames(result));
    result = names.text;
    counts.names = names.count;

    return { text: result, counts };
  } catch {
    return { text: "[REDACTION_ERROR]", counts: EMPTY_COUNTS };
  }
}

/**
 * Recurse through objects and arrays, redacting nested strings.
 * Primitives other than strings are returned as-is. Never throws.
 */
export function redactValue(value: unknown): unknown {
  const visited = new WeakSet<object>();

  const walk = (node: unknown): unknown => {
    if (node === null || node === undefined) {
      return node;
    }
    if (typeof node === "string") {
      return redact(node).text;
    }
    if (typeof node === "number" || typeof node === "boolean") {
      return node;
    }
    if (typeof node !== "object") {
      return node;
    }
    if (visited.has(node)) {
      return "[REDACTION_ERROR: circular reference]";
    }
    visited.add(node);
    if (Array.isArray(node)) {
      return node.map((item) => walk(item));
    }
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(node)) {
      output[key] = walk(nested);
    }
    return output;
  };

  try {
    return walk(value);
  } catch {
    return "[REDACTION_ERROR]";
  }
}

/**
 * Alias of `redact`. Storage and traces share one policy so a request cannot
 * be stored redacted and still leak in a span (or the reverse).
 */
export function redactForStorage(text: unknown): RedactionResult {
  return redact(text);
}

/** Alias of `redact`. See {@link redactForStorage}. */
export function redactForTrace(text: unknown): RedactionResult {
  return redact(text);
}
