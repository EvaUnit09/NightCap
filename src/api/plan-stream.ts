import "server-only";

import { z } from "zod";

import { getEnableLiveRoutes, getRateLimitDailySpendUsd, getRateLimitRequestsPerHour } from "../models/config";
import { costUsdFor } from "../models/pricing";
import { billableRoutesHops, clientIp, usdToMicros, utcDay, vendorMicros } from "../monitoring/spend-cap";
import { createSpendStoreFromEnv, type SpendStore } from "../monitoring/spend-store";
import { createPipelineDeps, runPipeline, WRAP_USER_TEXT_MAX_CHARS, type PipelineDeps, type PipelineFailure } from "../pipeline";
import type { Intent } from "../validation/intent";
import type { ItineraryOption } from "../validation/itinerary";

/** Body cap checked before JSON.parse. The text itself is capped at WRAP_USER_TEXT_MAX_CHARS. */
const BODY_MAX_CHARS = 4 * WRAP_USER_TEXT_MAX_CHARS;

const requestSchema = z.object({ text: z.string().trim().min(1).max(WRAP_USER_TEXT_MAX_CHARS) }).strict();

/**
 * The SSE protocol. `intent` comes first when parsing succeeded, then one
 * `itinerary` per option that passed validation and the emit gate, then
 * exactly one of `done` or `error`. An `error` carries a stage and a code
 * from closed unions, never free text, model output, or a stack.
 */
export type PlanEvent =
  | { readonly event: "intent"; readonly data: Intent }
  | { readonly event: "itinerary"; readonly data: { readonly index: number; readonly option: ItineraryOption } }
  | { readonly event: "done"; readonly data: { readonly options: number } }
  | {
      readonly event: "error";
      readonly data: PipelineFailure | { readonly stage: "internal"; readonly code: "internal_error" };
    };

export type PlanDepsFactory = () => PipelineDeps;

export interface PlanHandlerOptions {
  readonly store?: SpendStore;
  readonly now?: () => number;
}

const JSON_HEADERS = { "Cache-Control": "no-store" } as const;

type CapLimit = "daily_spend_cap" | "hourly_plan_limit" | "spend_cap_unavailable";

function limitResponse(kind: CapLimit): Response {
  switch (kind) {
    case "daily_spend_cap":
      return Response.json({ error: kind, message: "Come back tomorrow." }, { status: 429, headers: JSON_HEADERS });
    case "hourly_plan_limit":
      return Response.json(
        { error: kind, message: "Too many plans from this network. Try again in an hour." },
        { status: 429, headers: JSON_HEADERS },
      );
    case "spend_cap_unavailable":
      return Response.json({ error: kind }, { status: 503, headers: JSON_HEADERS });
    default: {
      const neverKind: never = kind;
      return neverKind;
    }
  }
}

interface RequestSpend {
  modelUsd: number;
  placesTextSearches: number;
  routesHops: number;
  /** Set from the pipeline audit when the run returns. Model-only; Places and Routes stay on the counters above. */
  auditModelUsd: number | null;
}

function observeDeps(deps: PipelineDeps, spend: RequestSpend): PipelineDeps {
  return {
    ...deps,
    models: {
      async complete(request) {
        const response = await deps.models.complete(request);
        spend.modelUsd += costUsdFor(request.model, response) ?? 0;
        return response;
      },
    },
    retrieve: async (intent, signal) => {
      const retrieval = await deps.retrieve(intent, signal);
      spend.placesTextSearches += retrieval.placesRequests;
      return retrieval;
    },
    validate: async (input) => {
      if (getEnableLiveRoutes()) {
        spend.routesHops += billableRoutesHops(input);
      }
      return deps.validate(input);
    },
  };
}

function spendMicros(spend: RequestSpend): number {
  return vendorMicros({
    modelUsd: spend.auditModelUsd ?? spend.modelUsd,
    placesTextSearches: spend.placesTextSearches,
    routesHops: spend.routesHops,
  });
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store, no-transform",
  "X-Accel-Buffering": "no",
} as const;

const encoder = new TextEncoder();

function badRequest(code: "invalid_json" | "invalid_request" | "too_large"): Response {
  return Response.json({ error: code }, { status: 400, headers: { "Cache-Control": "no-store" } });
}

function frame({ event, data }: PlanEvent): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Events for one finished pipeline run. `runPipeline` resolves with options
 * that already passed validation and `admitOption`, so mapping its result is
 * the only path an itinerary can take to the client.
 */
async function* planEvents(
  text: string,
  deps: PipelineDeps,
  signal: AbortSignal,
  spend: RequestSpend | null,
): AsyncGenerator<PlanEvent> {
  const result = await runPipeline({ text, signal }, deps);
  if (spend) spend.auditModelUsd = result.audit.totalCostUsd;
  if (result.intent !== null) {
    yield { event: "intent", data: result.intent };
  }
  if (result.kind === "failed") {
    yield { event: "error", data: result.failure };
    return;
  }
  for (const [index, emitted] of result.options.entries()) {
    yield { event: "itinerary", data: { index, option: emitted.option } };
  }
  yield { event: "done", data: { options: result.options.length } };
}

function streamPlan(
  text: string,
  makeDeps: PlanDepsFactory,
  request: Request,
  onSpend?: (micros: number) => Promise<void>,
): Response {
  const cancelled = new AbortController();
  const signal = AbortSignal.any([request.signal, cancelled.signal]);
  const spend: RequestSpend | null = onSpend
    ? { modelUsd: 0, placesTextSearches: 0, routesHops: 0, auditModelUsd: null }
    : null;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const deps = spend ? observeDeps(makeDeps(), spend) : makeDeps();
        for await (const event of planEvents(text, deps, signal, spend)) {
          controller.enqueue(frame(event));
        }
      } catch {
        if (!signal.aborted) {
          controller.enqueue(frame({ event: "error", data: { stage: "internal", code: "internal_error" } }));
        }
      } finally {
        if (onSpend && spend) {
          try {
            await onSpend(spendMicros(spend));
          } catch {
            // The plan already left this process. Losing the ledger write beats turning a finished stream into a 500.
          }
        }
        if (!cancelled.signal.aborted) {
          controller.close();
        }
      }
    },
    cancel() {
      cancelled.abort();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

/**
 * POST handler factory. Deps are built inside the stream so a missing key
 * becomes a fixed `internal_error` event, and tests inject fakes.
 */
export function createPlanHandler(
  makeDeps: PlanDepsFactory,
  options: PlanHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const now = options.now ?? Date.now;
  return async (request) => {
    const raw = await request.text().catch(() => null);
    if (raw === null) {
      return badRequest("invalid_request");
    }
    if (raw.length > BODY_MAX_CHARS) {
      return badRequest("too_large");
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return badRequest("invalid_json");
    }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return badRequest("invalid_request");
    }

    const store = options.store;
    if (!store) {
      return streamPlan(parsed.data.text, makeDeps, request);
    }

    const at = now();
    const day = utcDay(at);
    let spent: number;
    try {
      spent = await store.readDailyMicros(day);
    } catch {
      return limitResponse("spend_cap_unavailable");
    }
    if (spent >= usdToMicros(getRateLimitDailySpendUsd())) {
      return limitResponse("daily_spend_cap");
    }

    let count: number;
    try {
      count = await store.recordPlan(clientIp(request), at);
    } catch {
      return limitResponse("spend_cap_unavailable");
    }
    if (count > getRateLimitRequestsPerHour()) {
      return limitResponse("hourly_plan_limit");
    }

    return streamPlan(parsed.data.text, makeDeps, request, async (micros) => {
      if (micros > 0) await store.addDailyMicros(day, micros);
    });
  };
}

/** Production POST. The app route stays free of `src/monitoring` imports. */
export function createProductionPlanHandler(): (request: Request) => Promise<Response> {
  return createPlanHandler(() => createPipelineDeps(), { store: createSpendStoreFromEnv() });
}
