const OFF_TOPIC_PATTERNS: readonly RegExp[] = [
  /\bwrite\s+(me\s+)?(some\s+|a\s+)?(code|script|python|typescript|javascript)\b/i,
  /\b(debug|refactor)\s+(this|my)\s+code\b/i,
  /\bwho\s+will\s+win\s+the\s+(election|super\s*bowl)\b/i,
  /\b(political|politics)\b.*\b(opinion|endorse)\b/i,
  /\bwhat('s|\s+is)\s+the\s+weather\b/i,
  /\b(tell|give)\s+me\s+a\s+joke\b/i,
  /\bhomework\b/i,
  /\bcrypto\s+(price|trading)\b/i,
];

const ON_TOPIC_HINTS: readonly RegExp[] = [
  /\b(dinner|drinks|dessert|bar|brunch|coffee|venue|stop|itinerary|night|swap|replace|reorder|cheaper|later|earlier|budget)\b/i,
];

/** True when the edit is clearly not an itinerary refinement request. */
export function isOffTopic(editText: string): boolean {
  const text = editText.trim();
  if (text.length === 0) return true;
  if (OFF_TOPIC_PATTERNS.some((pattern) => pattern.test(text))) {
    return !ON_TOPIC_HINTS.some((pattern) => pattern.test(text));
  }
  return false;
}
