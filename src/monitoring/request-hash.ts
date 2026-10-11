import "server-only";

import { createHmac } from "node:crypto";

import { getRequestHashSecret } from "../models/config";
import type { RequestHash } from "./trace-types";

/**
 * HMAC-SHA256 of the raw request. Short requests are guessable under
 * plain SHA-256, so the key never leaves the server (#27, #32).
 */
export function hashRequest(text: string, secret?: string): RequestHash {
  const key = secret ?? getRequestHashSecret();
  return createHmac("sha256", key).update(text, "utf8").digest("hex") as RequestHash;
}
