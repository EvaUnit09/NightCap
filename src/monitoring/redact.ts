/**
 * PII redaction module for NightCap.
 *
 * Deterministically redacts person names, emails, phone numbers, addresses, and
 * other PII from free text before database writes or tracing. Preserves venue,
 * neighborhood, and food terms as they are required for itinerary planning.
 *
 * Known limitations:
 * - Name detection uses heuristic patterns and may miss uncommon phrasings
 * - Single-word names without context (e.g. "Sarah went") may not be caught
 * - Ambiguous terms (e.g. "Jordan" as person vs. neighborhood) may be redacted
 * - Non-English names and non-Latin scripts have limited support
 * - Business names containing person names are preserved when recognizable
 */

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
  /** Text with PII replaced by [REDACTED] or category-specific markers */
  readonly text: string;
  /** Count of redactions by category */
  readonly counts: RedactionCounts;
}

/**
 * Patterns for detecting PII. Ordered by specificity (most specific first).
 */

// Email pattern: captures common email formats
const EMAIL_PATTERN =
  /\b[A-Za-z0-9]([A-Za-z0-9._%+-]*[A-Za-z0-9])?@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}\b/gi;

// Phone patterns: US and international formats
// Matches: (123) 456-7890, 123-456-7890, 1234567890, +1 123 456 7890, etc.
const PHONE_PATTERN =
  /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/gi;

// Street address patterns
// Matches: "123 Main St", "45 W 23rd Street", "1600 Pennsylvania Avenue"
const STREET_ADDRESS_PATTERN =
  /\b\d{1,6}\s+(?:(?:North|South|East|West|N|S|E|W)\.?\s+)?\d*\w*\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Place|Pl|Way|Parkway|Pkwy)\.?(?:\s+(?:North|South|East|West|N|S|E|W)\.?)?/gi;

// Zip code pattern (5 or 9 digit US zip codes)
const ZIP_CODE_PATTERN = /\b\d{5}(?:-\d{4})?\b/g;

/**
 * Common name context patterns that indicate a person name follows.
 * Ordered by specificity to avoid overlapping matches.
 */
const NAME_CONTEXT_PATTERNS = [
  // Possessive relationships (most specific first)  
  /\b(?:my|his|her|their|our)\s+(?:friend|girlfriend|boyfriend|partner|spouse|husband|wife|brother|sister|cousin|mom|dad|mother|father|son|daughter|aunt|uncle|nephew|niece|colleague|coworker|boss|manager)\s+([A-Z][a-z]+(?:(?:\s*,\s*[A-Z][a-z]+)+(?:\s*,?\s*(?:and|&amp;|&)\s+[A-Z][a-z]+)?|\s+(?:and|&amp;|&)\s+[A-Z][a-z]+)?)/gi,

  // Meet/meeting with (before plain 'with' to take precedence)
  /\b(?:meet|met|meeting)\s+with\s+([A-Z][a-z]+(?:(?:\s*,\s*[A-Z][a-z]+)+(?:\s*,?\s*(?:and|&amp;|&)\s+[A-Z][a-z]+)?|\s+(?:and|&amp;|&)\s+[A-Z][a-z]+)?)/gi,

  // Plain 'with' preposition
  // Matches: "with Name", "with Name and Name", "with Name, Name, and Name"
  /\bwith\s+([A-Z][a-z]+(?:\s*,\s*[A-Z][a-z]+)*(?:\s*,?\s*(?:and|&amp;|&)\s+[A-Z][a-z]+)?)/g,

  // Named introductions
  /\b(?:named|called)\s+([A-Z][a-z]+)/gi,

  // Direct address
  /\b(?:hi|hey|hello|dear)\s+([A-Z][a-z]+)/gi,
];

/**
 * Terms to preserve - venue types, neighborhoods, food terms that should not be redacted
 * even if they appear in name-like contexts. Lowercase for case-insensitive matching.
 */
const PRESERVE_TERMS = new Set([
  // Days of week
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  // Months
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  // NYC neighborhoods and areas
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
  // Common food/cuisine terms
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
]);

/**
 * Check if a word should be preserved (not redacted).
 */
function shouldPreserve(word: string): boolean {
  return PRESERVE_TERMS.has(word.toLowerCase());
}

/**
 * Redact person names from text based on context patterns.
 * Uses markers to prevent double-redaction from overlapping patterns.
 */
function redactNames(text: string): { text: string; count: number } {
  let result = text;
  let count = 0;
  const TEMP_MARKER = "___REDACTED_NAME___";

  for (const pattern of NAME_CONTEXT_PATTERNS) {
    result = result.replace(pattern, (match, ...args) => {
      // Skip if already redacted
      if (match.includes(TEMP_MARKER) || match.includes("[NAME]")) {
        return match;
      }

      // The captured group is the name(s)
      const names = args[0] as string;

      // Split on 'and', '&', commas to handle multiple names
      const nameList = names.split(/\s*,\s*|\s+and\s+|\s*&amp;\s*|\s*&\s*/i).filter((n) => n.trim());

      // Check if any name should be preserved
      const shouldRedact = nameList.some((name) => !shouldPreserve(name.trim()));

      if (shouldRedact) {
        // Redact the entire name portion
        const prefix = match.substring(0, match.indexOf(names));
        count++;
        return prefix + TEMP_MARKER;
      }

      return match;
    });
  }

  // Replace temporary markers with final [NAME] marker
  result = result.replace(new RegExp(TEMP_MARKER, "g"), "[NAME]");

  return { text: result, count };
}

/**
 * Redact PII from free text.
 *
 * Returns the redacted text and counts of each redaction category.
 * Deterministic and does not make external calls.
 *
 * @param text - The input text potentially containing PII
 * @returns Redaction result with sanitized text and counts
 *
 * @example
 * ```ts
 * const result = redact("Meeting my friend Sarah at 123 Main St, call me at 555-1234");
 * // result.text: "Meeting my friend [NAME] at [ADDRESS], call me at [PHONE]"
 * // result.counts: { names: 1, emails: 0, phones: 1, addresses: 1 }
 * ```
 */
export function redact(text: string): RedactionResult {
  let result = text;
  const counts: { names: number; emails: number; phones: number; addresses: number } = {
    names: 0,
    emails: 0,
    phones: 0,
    addresses: 0,
  };

  // 1. Redact emails
  result = result.replace(EMAIL_PATTERN, () => {
    counts.emails++;
    return "[EMAIL]";
  });

  // 2. Redact phone numbers
  result = result.replace(PHONE_PATTERN, () => {
    counts.phones++;
    return "[PHONE]";
  });

  // 3. Redact street addresses (before zip codes to avoid double-counting)
  result = result.replace(STREET_ADDRESS_PATTERN, () => {
    counts.addresses++;
    return "[ADDRESS]";
  });

  // 4. Redact zip codes
  result = result.replace(ZIP_CODE_PATTERN, () => {
    // Only redact if it looks like a standalone zip (not part of a larger number)
    counts.addresses++;
    return "[ZIP]";
  });

  // 5. Redact person names (do this last to preserve context for other patterns)
  const nameRedaction = redactNames(result);
  result = nameRedaction.text;
  counts.names = nameRedaction.count;

  return {
    text: result,
    counts,
  };
}

/**
 * Convenience function for redacting text before database storage.
 * Alias for `redact()` with a clear intent.
 */
export function redactForStorage(text: string): RedactionResult {
  return redact(text);
}

/**
 * Convenience function for redacting text before adding to tracing spans.
 * Alias for `redact()` with a clear intent.
 */
export function redactForTrace(text: string): RedactionResult {
  return redact(text);
}
