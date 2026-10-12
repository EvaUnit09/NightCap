import "server-only";

import { hashRequest } from "./request-hash";
import { redactForStorage, type RedactionErrorCode } from "./redact";

export interface Queryable {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface StoredRequest {
  readonly redactedText: string;
  readonly parsedIntent: Record<string, unknown>;
  readonly clientHash: string;
}

export type PrepareStoredRequestResult =
  | { readonly ok: true; readonly row: StoredRequest }
  | { readonly ok: false; readonly error: RedactionErrorCode | "invalid_intent" };

const INSERT_STORED_REQUEST = `
INSERT INTO public.requests (redacted_text, parsed_intent, client_hash)
VALUES ($1, $2::jsonb, $3)
RETURNING id
`;

export function prepareStoredRequest(
  rawText: string,
  parsedIntent: Record<string, unknown>,
  hashSecret: string,
): PrepareStoredRequestResult {
  if (!isPlainJsonObject(parsedIntent)) {
    return { ok: false, error: "invalid_intent" };
  }
  const redacted = redactForStorage(rawText);
  if (!redacted.ok) {
    return { ok: false, error: redacted.error };
  }
  return {
    ok: true,
    row: {
      redactedText: redacted.text,
      parsedIntent,
      clientHash: hashRequest(rawText, hashSecret),
    },
  };
}

export async function insertStoredRequest(
  db: Queryable,
  row: StoredRequest,
): Promise<{ id: string }> {
  if (!isPlainJsonObject(row.parsedIntent)) {
    throw new Error("parsed_intent must be a plain JSON object");
  }
  const inserted = await db.query<{ id: string }>(INSERT_STORED_REQUEST, [
    row.redactedText,
    JSON.stringify(row.parsedIntent),
    row.clientHash,
  ]);
  return inserted.rows[0];
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
