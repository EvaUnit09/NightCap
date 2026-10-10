/**
 * PII redaction module for NightCap.
 *
 * Deterministically redacts person names, emails, phone numbers, addresses, and
 * other PII from free text before database writes or tracing. Preserves venue,
 * neighborhood, and food terms as required for itinerary planning.
 *
 * Input size: capped at 4KB to prevent ReDoS attacks.
 *
 * Known limitations:
 * - Context-free single names without relationship/greeting context may not be caught
 * - Non-English text and non-Latin scripts have limited support
 * - Months/days used as names after relationship words ARE redacted ("my girlfriend June")
 * - Business names in possessive form are partially protected ("Joe's Pizza" preserved, but "with Joe" may redact)
 */

const MAX_INPUT_LENGTH = 4096; // 4KB cap to prevent ReDoS

/**
 * Counts of redactions by category.
 */
export interface RedactionCounts {
  readonly names: number;
  readonly emails: number;
  readonly phones: number;
  readonly addresses: number;
}

/**
 * Result of redacting PII from text.
 */
export interface RedactionResult {
  /** Text with PII replaced by category-specific markers */
  readonly text: string;
  /** Count of redactions by category */
  readonly counts: RedactionCounts;
}

/**
 * Bounded email pattern - prevents ReDoS by capping local/domain part lengths.
 * local: 1-64 chars, domain: 1-253 chars, TLD: 2-24 chars
 */
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/gi;

/**
 * Phone patterns: US and international formats.
 * Handles: (123) 456-7890, 123-456-7890, 1234567890, +1 123 456 7890,
 * international: +44 20 7946 0958, +33 6 12 34 56 78
 * Extensions handled separately.
 */
const PHONE_PATTERNS = [
  // International with + country code: +44 20 7946 0958, +33 6 12 34 56 78
  /\+\d{1,3}\s+\d{1,4}\s+\d{3,4}\s+\d{4}(?:\s+\d{2,4})?/g,
  // International compact: +442079460958
  /\+\d{10,15}/g,
  // US with country code: +1 (212) 555-1234
  /\+1\s*\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
  // US formats: (123) 456-7890, 123-456-7890, 123.456.7890
  /\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g,
  // 10-digit unformatted US
  /\b\d{10}\b/g,
];

/**
 * Street address pattern - bounded to prevent ReDoS.
 * Matches: "123 Main St", "45 W 23rd Street", "350 5th Ave", "200 E 10th St"
 * Handles: directionals, numbered streets/avenues, apartment numbers
 */
const STREET_ADDRESS_PATTERN =
  /\b\d{1,6}\s+(?:(?:North|South|East|West|N|S|E|W)\.?\s+)?(?:\d+(?:st|nd|rd|th))?\s*[A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20}){0,3}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Place|Pl|Way|Parkway|Pkwy|Plaza|Plz)\b(?:\s+(?:Apt|Unit|Suite|Ste|#)\s*[A-Za-z0-9]{1,6})?\b/gi;

/**
 * ZIP code pattern - only with context cue to avoid false positives.
 */
const ZIP_CODE_WITH_CONTEXT = /\b(?:ZIP|zip|Zip)\s+(\d{5}(?:-\d{4})?)\b/g;

/**
 * Name token: 1-3 capitalized Unicode tokens, supporting diacritics, hyphens, apostrophes.
 * Matches: Sarah, José, Zoë, Mary-Kate, O'Brien, McKenzie, DeShawn, John Smith, Dr. Patel
 * Requires at least one letter character after the initial uppercase.
 */
const NAME_TOKEN = /(?:\p{Lu}[\p{L}'''-]{1,19}(?:\s+\p{Lu}[\p{L}'''-]{1,19}){0,2})/u;

/**
 * Relationship words (case-insensitive)
 */
const RELATIONS =
  "friend|girlfriend|boyfriend|partner|spouse|husband|wife|brother|sister|cousin|mom|dad|mother|father|son|daughter|aunt|uncle|nephew|niece|colleague|coworker|boss|manager|fiancée?|bf|gf|date";

/**
 * Titles
 */
const TITLES = "Dr|Mr|Mrs|Ms|Mx";

/**
 * Name context patterns - case-insensitive cues with case-sensitive name capture.
 * Ordered by specificity.
 */
function buildNamePatterns(): RegExp[] {
  const nameCapture = NAME_TOKEN.source;

  return [
    // "my girlfriend, Name" (relationship + comma + name)
    new RegExp(`\\b(?:my|his|her|their|our)\\s+(?:${RELATIONS})\\s*,\\s*(${nameCapture})`, "giu"),

    // "my girlfriend Name" (relationship + name)
    new RegExp(`\\b(?:my|his|her|their|our)\\s+(?:${RELATIONS})\\s+(${nameCapture})`, "giu"),

    // "for Name and me/I" or "for me and Name"
    new RegExp(`\\bfor\\s+(?:(${nameCapture})\\s+and\\s+(?:me|I)|me\\s+and\\s+(${nameCapture}))`, "giu"),

    // "Name and me/I" at start
    new RegExp(`^\\s*(${nameCapture})\\s+and\\s+(?:me|I)\\b`, "giu"),

    // "Name and his/her"
    new RegExp(`\\b(${nameCapture})\\s+and\\s+(?:his|her)\\b`, "giu"),

    // "Name's birthday/anniversary/party"
    new RegExp(`\\b(${nameCapture})'s\\s+(?:birthday|anniversary|party|engagement)`, "giu"),

    // "taking/surprise/treat Name"
    new RegExp(`\\b(?:taking|surprise|treat)\\s+(${nameCapture})`, "giu"),

    // Title + Name (Dr. Patel, Mr. Smith)
    new RegExp(`\\b(?:${TITLES})\\.?\\s+(${nameCapture})`, "giu"),

    // "meeting with Name, Name, and Name" (Oxford comma)
    new RegExp(`\\bmeeting\\s+with\\s+(${nameCapture}(?:\\s*,\\s*${nameCapture})*(?:\\s*,?\\s*and\\s+${nameCapture})?)`, "giu"),

    // "with Name, Name, and Name" - BUT require person context (and me/I, or relationship word nearby)
    // This helps avoid "with Chelsea vibes"
    new RegExp(`\\bwith\\s+(${nameCapture})\\s+and\\s+(?:me|I)\\b`, "giu"),

    // "Name, Name, and Name" at start (Oxford comma list)
    new RegExp(`^\\s*(${nameCapture}(?:\\s*,\\s*${nameCapture})*(?:\\s*,?\\s*and\\s+${nameCapture}))\\s+(?:are|is)\\b`, "giu"),

    // Direct address: Hi/Hey/Hello Name
    new RegExp(`\\b(?:hi|hey|hello|dear)\\s+(${nameCapture})\\b`, "giu"),

    // Named (person context) - not "called" because that often refers to venues
    new RegExp(`\\b(?:named)\\s+(${nameCapture})\\b`, "giu"),

    // "with Name" only with clear person context:
    // - followed by "and me/I" (already handled above)
    // - OR in a personal context like "dinner|date|drinks with Name"
    new RegExp(`\\b(?:dinner|date|drinks|lunch|meal)\\s+with\\s+(${nameCapture})(?!\\s+(?:vibes?|food|views?|style|nearby|cocktails?|then|after))\\b`, "giu"),
  ];
}

/**
 * Terms to preserve - venue types, neighborhoods, food terms.
 * Also includes possessive markers ('s) which indicate venue names.
 */
const PRESERVE_TERMS = new Set([
  // Days
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  // Months (these ARE redacted if they appear as names after relationship words)
  // NYC neighborhoods
  "manhattan",
  "brooklyn",
  "queens",
  "bronx",
  "harlem",
  "chelsea",
  "soho",
  "tribeca",
  "village",
  "williamsburg",
  "bushwick",
  "astoria",
  "flushing",
  "murray",
  "hill",
  "jackson",
  "heights",
  "washington",
  "square",
  "madison",
  "garden",
  "bowery",
  "houston",
  "nolita",
  "east",
  "west",
  "lower",
  "side",
  "greenwich",
  "union",
  "rockefeller",
  "little",
  "italy",
  // Common food/cuisine
  "italian",
  "french",
  "chinese",
  "japanese",
  "korean",
  "thai",
  "vietnamese",
  "indian",
  "mexican",
  "american",
  "mediterranean",
  "greek",
  "spanish",
  // Venue types
  "bar",
  "restaurant",
  "cafe",
  "lounge",
  "club",
  "bistro",
  "tavern",
  "grill",
  "pizza",
  "sushi",
  "ramen",
  "tapas",
  "house",
  "plaza",
  "park",
  // Food words
  "brunch",
  "dinner",
  "drinks",
  "cocktails",
  "vibes",
  "food",
  "views",
  "style",
]);

/**
 * Check if a captured name should be preserved (venue/place term or possessive venue).
 */
function shouldPreserve(text: string, fullMatch: string): boolean {
  const normalized = text.trim().toLowerCase();

  // Check for possessive form (venue name like "Joe's")
  if (fullMatch.includes("'s ") && !fullMatch.match(/\b(?:birthday|anniversary|party|engagement)\b/i)) {
    return true; // Possessive not followed by birthday/party is likely a venue
  }

  // Check word-by-word
  const words = normalized.split(/\s+/);
  return words.every((word) => PRESERVE_TERMS.has(word));
}

/**
 * Redact person names from text based on context patterns.
 */
function redactNames(text: string): { text: string; count: number } {
  let result = text;
  let count = 0;
  const TEMP_MARKER = "___REDACTED_NAME___";
  const patterns = buildNamePatterns();

  for (const pattern of patterns) {
    result = result.replace(pattern, (match, ...groups) => {
      // Skip if already redacted
      if (match.includes(TEMP_MARKER) || match.includes("[NAME]")) {
        return match;
      }

      // Find the captured name (first non-undefined group)
      const nameCapture = groups.find((g) => g && typeof g === "string");
      if (!nameCapture) {
        return match;
      }

      // Check preservation
      if (shouldPreserve(nameCapture, match)) {
        return match;
      }

      // Redact
      count++;
      const prefix = match.substring(0, match.indexOf(nameCapture));
      const suffix = match.substring(match.indexOf(nameCapture) + nameCapture.length);
      return prefix + TEMP_MARKER + suffix;
    });
  }

  // Replace temp markers
  result = result.replace(new RegExp(TEMP_MARKER, "g"), "[NAME]");

  return { text: result, count };
}

/**
 * Redact PII from free text.
 *
 * Returns the redacted text and counts of each redaction category.
 * Deterministic and does not make external calls.
 *
 * Input is capped at 4KB to prevent ReDoS attacks. Oversized input fails closed
 * by replacing the entire text with [REDACTION_ERROR].
 *
 * @param text - The input text potentially containing PII
 * @returns Redaction result with sanitized text and counts
 */
export function redact(text: string): RedactionResult {
  // Coerce to string
  if (typeof text !== "string") {
    text = String(text ?? "");
  }

  // Fail closed on oversized input
  if (text.length > MAX_INPUT_LENGTH) {
    return {
      text: "[REDACTION_ERROR: input exceeds 4KB limit]",
      counts: { names: 0, emails: 0, phones: 0, addresses: 0 },
    };
  }

  let result = text;
  const counts: { names: number; emails: number; phones: number; addresses: number } = {
    names: 0,
    emails: 0,
    phones: 0,
    addresses: 0,
  };

  try {
    // 1. Redact emails
    result = result.replace(EMAIL_PATTERN, () => {
      counts.emails++;
      return "[EMAIL]";
    });

    // 2. Redact phone numbers
    for (const phonePattern of PHONE_PATTERNS) {
      result = result.replace(phonePattern, () => {
        counts.phones++;
        return "[PHONE]";
      });
    }

    // 3. Redact street addresses
    result = result.replace(STREET_ADDRESS_PATTERN, () => {
      counts.addresses++;
      return "[ADDRESS]";
    });

    // 4. Redact ZIP codes (only with context)
    result = result.replace(ZIP_CODE_WITH_CONTEXT, (match, zip) => {
      counts.addresses++;
      return match.replace(zip, "[ZIP]");
    });

    // 5. Redact person names (do this last to preserve context for other patterns)
    const nameRedaction = redactNames(result);
    result = nameRedaction.text;
    counts.names = nameRedaction.count;
  } catch (error) {
    // Fail closed on any internal error
    return {
      text: "[REDACTION_ERROR]",
      counts: { names: 0, emails: 0, phones: 0, addresses: 0 },
    };
  }

  return {
    text: result,
    counts,
  };
}

/**
 * Recursively redact PII from any value (objects, arrays, primitives).
 *
 * Never throws - fails closed with [REDACTION_ERROR] on internal errors.
 * Handles circular references by skipping already-visited objects.
 *
 * @param value - Any value that may contain PII in nested strings
 * @returns The value with all strings redacted
 */
export function redactValue(value: unknown, visited = new WeakSet()): unknown {
  try {
    // Primitives
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === "string") {
      return redact(value).text;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return value;
    }

    // Circular reference protection
    if (typeof value === "object") {
      if (visited.has(value as object)) {
        return "[REDACTION_ERROR: circular reference]";
      }
      visited.add(value as object);
    }

    // Arrays
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, visited));
    }

    // Objects
    if (typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        result[key] = redactValue(val, visited);
      }
      return result;
    }

    // Fallback for functions, symbols, etc.
    return value;
  } catch (error) {
    return "[REDACTION_ERROR]";
  }
}

/**
 * Convenience function for redacting text before database storage.
 * Currently an alias for `redact()`.
 */
export function redactForStorage(text: string): RedactionResult {
  return redact(text);
}

/**
 * Convenience function for redacting text before adding to tracing spans.
 * Currently an alias for `redact()`.
 */
export function redactForTrace(text: string): RedactionResult {
  return redact(text);
}
