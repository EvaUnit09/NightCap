import "server-only";

import { inTransaction } from "../db/transaction";
import type { ItineraryOption } from "../validation/itinerary";
import { insertStoredRequest, prepareStoredRequest, type Queryable } from "./store-request";
import { assertStoredStops, stripStopForStorage, type StoredStop } from "./stored-stop";

export interface PlanOptionInput {
  readonly optionIndex: number;
  readonly option: ItineraryOption;
}

export interface PlanSaveInput {
  readonly rawText: string;
  readonly intent: Record<string, unknown> | null;
  readonly options: readonly PlanOptionInput[];
  readonly promptVersions: Readonly<Record<string, string>>;
  readonly models: Readonly<Record<string, string>>;
  readonly costUsd: number;
  readonly latencyMs: number;
}

export interface SavedPlan {
  readonly requestId: string;
  readonly itineraryIds: readonly string[];
}

export interface PlanPersistence {
  save(input: PlanSaveInput): Promise<SavedPlan | null>;
}

const INSERT_ITINERARY = `
INSERT INTO public.itineraries (
  request_id, option_index, stops, valid, validation_errors, prompt_versions, models, cost_usd, latency_ms
)
VALUES ($1, $2, $3::jsonb, true, NULL, $4::jsonb, $5::jsonb, $6, $7)
RETURNING id
`;

export function createPlanPersistence(db: Queryable, hashSecret: string): PlanPersistence {
  return {
    save(input) {
      return savePlan(db, input, hashSecret);
    },
  };
}

/**
 * Writes the redacted request when parse produced an intent.
 * Itinerary rows are only the options that finished validation.
 * A failure before parse writes nothing.
 */
export async function savePlan(db: Queryable, input: PlanSaveInput, hashSecret: string): Promise<SavedPlan | null> {
  if (input.intent === null) return null;
  const prepared = prepareStoredRequest(input.rawText, input.intent, hashSecret);
  if (!prepared.ok) return null;
  if (!Number.isFinite(input.costUsd) || input.costUsd < 0) {
    throw new Error("plan cost must be a finite non-negative number");
  }
  if (!Number.isInteger(input.latencyMs) || input.latencyMs < 0) {
    throw new Error("plan latency must be a non-negative integer");
  }

  const rows = input.options.map((option) => ({
    optionIndex: option.optionIndex,
    stops: option.option.stops.map((stop) => stripStopForStorage(stop)),
  }));
  for (const row of rows) assertStoredStops(row.stops);

  return inTransaction(db, async (tx) => {
    const request = await insertStoredRequest(tx, prepared.row);
    const itineraryIds: string[] = [];
    for (const row of rows) {
      const inserted = await tx.query<{ id: string }>(INSERT_ITINERARY, [
        request.id,
        row.optionIndex,
        JSON.stringify(row.stops),
        JSON.stringify(input.promptVersions),
        JSON.stringify(input.models),
        input.costUsd,
        input.latencyMs,
      ]);
      const id = inserted.rows[0]?.id;
      if (!id) throw new Error("itinerary insert returned no id");
      itineraryIds.push(id);
    }
    return { requestId: request.id, itineraryIds };
  });
}

export function modelsFromCalls(calls: readonly { readonly stage: string; readonly model: string }[]): Record<string, string> {
  const models: Record<string, string> = {};
  for (const call of calls) {
    models[call.stage] = call.model;
  }
  return models;
}

export type { StoredStop };
