import "server-only";

/**
 * 8 KiB after NFKC (CPU bound, before the strip regex) and again after
 * stripping zero-width/control characters (content bound). Strip only
 * shortens, so both checks use this constant.
 */
export const WRAP_USER_TEXT_MAX_CHARS = 8 * 1024;

const WRAPPER_OPEN = "<user_text>\n";
const WRAPPER_CLOSE = "\n</user_text>";

/** C0/C1 (except tab/LF/CR), soft hyphen, zero-width except ZWJ (U+200D), BOM. */
const STRIP_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u180E\u200B\u200C\u2060\uFEFF]/g;

function unwrapIfWrapped(text: string): string {
  if (text.startsWith(WRAPPER_OPEN) && text.endsWith(WRAPPER_CLOSE)) {
    return text.slice(WRAPPER_OPEN.length, text.length - WRAPPER_CLOSE.length);
  }
  return text;
}

/**
 * Wrap untrusted user text for prompt interpolation.
 * NFKC-normalizes, caps length, strips format/control characters (keeps ZWJ),
 * caps again after the strip, then escapes every `<` and `>` so the wrapper
 * pair is the only tag. Idempotent.
 * Not wired into the pipeline yet (architecture action #15).
 */
export function wrapUserText(text: string): string {
  const normalized = unwrapIfWrapped(text).normalize("NFKC");
  if (normalized.length > WRAP_USER_TEXT_MAX_CHARS) {
    throw new Error("User text exceeds the maximum length.");
  }

  const stripped = normalized.replace(STRIP_CHARS, "");
  if (stripped.length > WRAP_USER_TEXT_MAX_CHARS) {
    throw new Error("User text exceeds the maximum length.");
  }

  const sanitized = stripped.replaceAll("<", "‹").replaceAll(">", "›");

  return `${WRAPPER_OPEN}${sanitized}${WRAPPER_CLOSE}`;
}
