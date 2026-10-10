import "server-only";

const USER_TEXT_TAG = /<\s*\/?\s*user_text\s*>/gi;

/**
 * Wrap untrusted user text for prompt interpolation.
 * Neutralizes any opening or closing `user_text` tags inside the payload
 * (case-insensitive, whitespace variants) so they cannot break out.
 * Not wired into the pipeline yet (architecture action #15).
 */
export function wrapUserText(text: string): string {
  const neutralized = text.replace(USER_TEXT_TAG, (tag) =>
    tag.replaceAll("<", "‹").replaceAll(">", "›")
  );
  return `<user_text>\n${neutralized}\n</user_text>`;
}
