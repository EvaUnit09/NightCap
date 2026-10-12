import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_INPUT_CHARS, hashRequest, prepareStoredRequest, insertStoredRequest } from "../../src/monitoring";
import { createMigratedDatabase } from "../migrations/harness";

const HASH_SECRET = "test-hash-secret";
const RAW_WITH_EMAIL = "Book a table for ada@example.com";
const REDACTED_WITH_EMAIL = "Book a table for [EMAIL]";

describe("prepareStoredRequest", () => {
  it("stores redacted text and a stable hash of the raw request", () => {
    const parsedIntent = { partySize: 2 };
    const first = prepareStoredRequest(RAW_WITH_EMAIL, parsedIntent, HASH_SECRET);
    const second = prepareStoredRequest(RAW_WITH_EMAIL, parsedIntent, HASH_SECRET);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) {
      return;
    }

    assert.equal(first.row.redactedText, REDACTED_WITH_EMAIL);
    assert.equal(first.row.redactedText.includes("ada@example.com"), false);
    assert.equal(second.row.redactedText, first.row.redactedText);
    assert.match(first.row.clientHash, /^[0-9a-f]{64}$/);
    assert.notEqual(first.row.clientHash, RAW_WITH_EMAIL);
    assert.equal(first.row.clientHash, hashRequest(RAW_WITH_EMAIL, HASH_SECRET));
    assert.equal(second.row.clientHash, first.row.clientHash);
    assert.equal(JSON.stringify(first).includes("ada@example.com"), false);
  });

  it("refuses an over-long request and does not query", async () => {
    const raw = `ada@example.com${"x".repeat(MAX_INPUT_CHARS)}`;
    const db = {
      async query(): Promise<{ rows: [] }> {
        throw new Error("query must not be called");
      },
    };

    const prepared = prepareStoredRequest(raw, { partySize: 2 }, HASH_SECRET);
    if (prepared.ok) {
      await insertStoredRequest(db, prepared.row);
    }
    assert.equal(prepared.ok, false);
    if (!prepared.ok) {
      assert.equal(prepared.error, "too_long");
      assert.equal("row" in prepared, false);
      assert.equal(JSON.stringify(prepared).includes("ada@example.com"), false);
    }
  });

  it("refuses a non-object parsed intent and does not query", async () => {
    const db = {
      async query(): Promise<{ rows: [] }> {
        throw new Error("query must not be called");
      },
    };
    const illegal = [null, ["not", "an", "object"], "intent"] as const;
    for (const parsedIntent of illegal) {
      const prepared = prepareStoredRequest(
        RAW_WITH_EMAIL,
        parsedIntent as unknown as Record<string, unknown>,
        HASH_SECRET,
      );
      if (prepared.ok) {
        await insertStoredRequest(db, prepared.row);
      }
      assert.equal(prepared.ok, false);
      if (!prepared.ok) {
        assert.equal(prepared.error, "invalid_intent");
        assert.equal(JSON.stringify(prepared).includes("ada@example.com"), false);
      }
    }
  });
});

describe("insertStoredRequest", () => {
  it("persists the redacted text and client hash", async () => {
    const db = await createMigratedDatabase();
    try {
      const prepared = prepareStoredRequest(RAW_WITH_EMAIL, { partySize: 2 }, HASH_SECRET);
      assert.equal(prepared.ok, true);
      if (!prepared.ok) {
        return;
      }

      const inserted = await insertStoredRequest(db, prepared.row);
      const selected = await db.query<{
        redacted_text: string;
        client_hash: string;
        parsed_intent: { partySize: number };
      }>(
        `SELECT redacted_text, client_hash, parsed_intent
         FROM public.requests
         WHERE id = $1`,
        [inserted.id],
      );

      assert.equal(selected.rows.length, 1);
      assert.equal(selected.rows[0].redacted_text, REDACTED_WITH_EMAIL);
      assert.equal(selected.rows[0].redacted_text, prepared.row.redactedText);
      assert.equal(selected.rows[0].redacted_text.includes("ada@example.com"), false);
      assert.equal(selected.rows[0].client_hash, prepared.row.clientHash);
      assert.deepEqual(selected.rows[0].parsed_intent, { partySize: 2 });
    } finally {
      await db.close();
    }
  });
});
