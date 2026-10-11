import "server-only";

/**
 * 8 KiB after NFKC, before the strip regex, to bound wrap CPU.
 * Strip only shortens, so the cap is intentionally not re-checked after.
 */
export const WRAP_USER_TEXT_MAX_CHARS = 8 * 1024;

const WRAPPER_OPEN = "<user_text>\n";
const WRAPPER_CLOSE = "\n</user_text>";

/**
 * C0/C1 (except tab/LF/CR), soft hyphen, zero-width except ZWJ (U+200D),
 * bidi controls, and BOM.
 */
const STRIP_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u180E\u200B\u200C\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

function unwrapIfWrapped(text: string): string {
  if (text.startsWith(WRAPPER_OPEN) && text.endsWith(WRAPPER_CLOSE)) {
    return text.slice(WRAPPER_OPEN.length, text.length - WRAPPER_CLOSE.length);
  }
  return text;
}

/**
 * Wrap untrusted user text for prompt interpolation.
 * NFKC-normalizes, caps length, strips format/control/bidi characters (keeps ZWJ),
 * then escapes every `<` and `>` so the wrapper pair is the only tag. Idempotent.
 * Not wired into the pipeline yet (architecture action #15).
 */
export function wrapUserText(text: string): string {
  const normalized = unwrapIfWrapped(text).normalize("NFKC");
  if (normalized.length > WRAP_USER_TEXT_MAX_CHARS) {
    throw new Error("User text exceeds the maximum length.");
  }

  const sanitized = normalized
    .replace(STRIP_CHARS, "")
    .replaceAll("<", "‹")
    .replaceAll(">", "›");

  return `${WRAPPER_OPEN}${sanitized}${WRAPPER_CLOSE}`;
}
