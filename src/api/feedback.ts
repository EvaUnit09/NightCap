import "server-only";

import { createQueryableFromEnv } from "../db/postgres";
import { recordFeedback } from "../monitoring/record-feedback";
import type { Queryable } from "../monitoring/store-request";
import { feedbackBodySchema } from "./feedback-body";

const JSON_HEADERS = { "Cache-Control": "no-store" } as const;
const BODY_MAX_CHARS = 16_000;

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: JSON_HEADERS });
}

export function createFeedbackHandler(db: Queryable): (request: Request) => Promise<Response> {
  return async (request) => {
    const raw = await request.text().catch(() => null);
    if (raw === null) return json({ error: "invalid_request" }, 400);
    if (raw.length > BODY_MAX_CHARS) return json({ error: "too_large" }, 400);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const parsed = feedbackBodySchema.safeParse(body);
    if (!parsed.success) return json({ error: "invalid_request" }, 400);

    const recorded = await recordFeedback(db, parsed.data.itineraryId, parsed.data.signal);
    if (!recorded.ok) {
      switch (recorded.error) {
        case "not_found":
          return json({ error: "not_found" }, 404);
        case "unknown_place":
          return json({ error: "unknown_place" }, 422);
        case "unjoinable":
          return json({ error: "unjoinable" }, 409);
        default: {
          const neverError: never = recorded.error;
          return neverError;
        }
      }
    }
    return json(
      { id: recorded.row.id, itineraryId: recorded.row.itineraryId, requestHash: recorded.row.requestHash },
      recorded.row.replayed ? 200 : 201,
    );
  };
}

export function createProductionFeedbackHandler(): (request: Request) => Promise<Response> {
  const db = createQueryableFromEnv();
  if (!db) {
    return async () => json({ error: "persist_unconfigured" }, 503);
  }
  return createFeedbackHandler(db);
}
