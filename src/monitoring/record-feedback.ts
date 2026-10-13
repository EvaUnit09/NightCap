import "server-only";

import { z } from "zod";

import type { FeedbackSignal } from "../api/feedback-body";
import { storedStopSchema } from "./stored-stop";
import type { Queryable } from "./store-request";

const REQUEST_HASH = /^[0-9a-f]{64}$/;

const loadedSchema = z.object({
  id: z.string().uuid(),
  stops: z.array(storedStopSchema),
  client_hash: z.string().nullable(),
});

export interface RecordedFeedback {
  readonly id: string;
  readonly itineraryId: string;
  readonly requestHash: string;
  readonly replayed: boolean;
}

export type RecordFeedbackResult =
  | { readonly ok: true; readonly row: RecordedFeedback }
  | { readonly ok: false; readonly error: "not_found" | "unknown_place" | "unjoinable" };

interface SignalColumns {
  readonly thumbs: -1 | 1 | null;
  readonly wouldGo: boolean | null;
  readonly didGo: boolean | null;
  readonly newToYou: Record<string, boolean> | null;
  readonly closedPlaceId: string | null;
}

const LOAD_ITINERARY = `
SELECT i.id, i.stops, r.client_hash
FROM public.itineraries AS i
JOIN public.requests AS r ON r.id = i.request_id
WHERE i.id = $1
`;

const LATEST_SAME_SIGNAL = `
SELECT id, request_hash, thumbs, would_go, did_go, new_to_you, closed_report_place_id
FROM public.feedback
WHERE itinerary_id = $1
  AND request_hash = $2
  AND thumbs IS NOT DISTINCT FROM $3
  AND would_go IS NOT DISTINCT FROM $4
  AND did_go IS NOT DISTINCT FROM $5
  AND closed_report_place_id IS NOT DISTINCT FROM $7
  AND new_to_you IS NOT DISTINCT FROM $6::jsonb
ORDER BY created_at DESC, ctid DESC
LIMIT 1
`;

const INSERT_FEEDBACK = `
INSERT INTO public.feedback (
  itinerary_id, request_hash, thumbs, would_go, did_go, new_to_you, closed_report_place_id
)
VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
RETURNING id
`;

function columnsFor(signal: FeedbackSignal): SignalColumns {
  switch (signal.kind) {
    case "thumbs":
      return { thumbs: signal.thumbs, wouldGo: null, didGo: null, newToYou: null, closedPlaceId: null };
    case "would_go":
      return { thumbs: null, wouldGo: signal.wouldGo, didGo: null, newToYou: null, closedPlaceId: null };
    case "did_go":
      return { thumbs: null, wouldGo: null, didGo: signal.didGo, newToYou: null, closedPlaceId: null };
    case "new_to_you":
      return {
        thumbs: null,
        wouldGo: null,
        didGo: null,
        newToYou: { [signal.placeId]: signal.value },
        closedPlaceId: null,
      };
    case "closed_venue":
      return { thumbs: null, wouldGo: null, didGo: null, newToYou: null, closedPlaceId: signal.placeId };
    default: {
      const neverSignal: never = signal;
      return neverSignal;
    }
  }
}

function placeIdsFor(signal: FeedbackSignal): readonly string[] {
  switch (signal.kind) {
    case "thumbs":
    case "would_go":
    case "did_go":
      return [];
    case "new_to_you":
    case "closed_venue":
      return [signal.placeId];
    default: {
      const neverSignal: never = signal;
      return neverSignal;
    }
  }
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function paramsFor(itineraryId: string, requestHash: string, columns: SignalColumns): unknown[] {
  return [
    itineraryId,
    requestHash,
    columns.thumbs,
    columns.wouldGo,
    columns.didGo,
    columns.newToYou === null ? null : JSON.stringify(columns.newToYou),
    columns.closedPlaceId,
  ];
}

export async function recordFeedback(
  db: Queryable,
  itineraryId: string,
  signal: FeedbackSignal,
): Promise<RecordFeedbackResult> {
  const loaded = await db.query<Record<string, unknown>>(LOAD_ITINERARY, [itineraryId]);
  const raw = loaded.rows[0];
  if (!raw) return { ok: false, error: "not_found" };
  const parsed = loadedSchema.safeParse({ ...raw, stops: jsonValue(raw.stops) });
  if (!parsed.success) return { ok: false, error: "not_found" };

  const requestHash = parsed.data.client_hash;
  if (requestHash === null || !REQUEST_HASH.test(requestHash)) {
    return { ok: false, error: "unjoinable" };
  }

  const knownPlaces = new Set(parsed.data.stops.map((stop) => stop.placeId));
  if (placeIdsFor(signal).some((placeId) => !knownPlaces.has(placeId))) {
    return { ok: false, error: "unknown_place" };
  }

  const columns = columnsFor(signal);
  const params = paramsFor(itineraryId, requestHash, columns);
  const existing = await db.query<{ id: string; request_hash: string | null }>(LATEST_SAME_SIGNAL, params);
  const prior = existing.rows[0];
  if (prior?.request_hash === requestHash) {
    return {
      ok: true,
      row: { id: prior.id, itineraryId, requestHash, replayed: true },
    };
  }

  const inserted = await db.query<{ id: string }>(INSERT_FEEDBACK, params);
  const id = inserted.rows[0]?.id;
  if (!id) return { ok: false, error: "not_found" };
  return { ok: true, row: { id, itineraryId, requestHash, replayed: false } };
}
