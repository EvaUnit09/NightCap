import "server-only";

/** Test-visible cap. 300KB timing coverage sits well under this. */
export const WRAP_USER_TEXT_MAX_CHARS = 1_048_576;

const WRAPPER_OPEN = "<user_text>\n";
const WRAPPER_CLOSE = "\n</user_text>";

/** C0/C1 controls (except tab/LF/CR), soft hyphen, zero-width, and BOM. */
const STRIP_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u180E\u200B-\u200D\u2060\uFEFF]/g;

function unwrapIfWrapped(text: string): string {
  if (text.startsWith(WRAPPER_OPEN) && text.endsWith(WRAPPER_CLOSE)) {
    return text.slice(WRAPPER_OPEN.length, text.length - WRAPPER_CLOSE.length);
  }
  return text;
}

/**
 * Wrap untrusted user text for prompt interpolation.
 * NFKC-normalizes, strips format/control characters, then escapes every
 * `<` and `>` so the wrapper pair is the only tag. Idempotent.
 * Not wired into the pipeline yet (architecture action #15).
 */
export function wrapUserText(text: string): string {
  const unwrapped = unwrapIfWrapped(text);
  if (unwrapped.length > WRAP_USER_TEXT_MAX_CHARS) {
    throw new Error("User text exceeds the maximum length.");
  }

  const sanitized = unwrapped
    .normalize("NFKC")
    .replace(STRIP_CHARS, "")
    .replaceAll("<", "‹")
    .replaceAll(">", "›");

  return `${WRAPPER_OPEN}${sanitized}${WRAPPER_CLOSE}`;
}
