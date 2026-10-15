import "server-only";

import { composePlanText, planRequestSchema } from "./plan-request";
import { createGoTrueAuth, userIdFromRequest } from "../auth/magic-link";
import { createQueryableFromEnv } from "../db/postgres";
import { getEnableLiveRoutes, getRateLimitDailySpendUsd, getRateLimitRequestsPerHour, getRequestHashSecret } from "../models/config";
import { costUsdFor } from "../models/pricing";
import {
  createMetricsSinkFromEnv,
  createNoopMetricsSink,
  planOutcomeSamples,
  spendFractionSample,
  type MetricSample,
  type MetricsSink,
  type PlanOutcome,
} from "../monitoring/metrics";
import { createPlanPersistence, modelsFromCalls, type PlanPersistence } from "../monitoring/persist-plan";
import { billableRoutesHops, clientIp, usdToMicros, utcDay, vendorMicros } from "../monitoring/spend-cap";
import { createSpendStoreFromEnv, type SpendStore } from "../monitoring/spend-store";
import { createPipelineDeps, runPipeline, WRAP_USER_TEXT_MAX_CHARS, type PipelineDeps, type PipelineFailure } from "../pipeline";
import type { Intent } from "../validation/intent";
import type { ItineraryOption } from "../validation/itinerary";

/** Body cap checked before JSON.parse. The text itself is capped at WRAP_USER_TEXT_MAX_CHARS. */
const BODY_MAX_CHARS = 4 * WRAP_USER_TEXT_MAX_CHARS;

/**
 * The SSE protocol. `intent` comes first when parsing succeeded, then one
 * `itinerary` per option that passed validation and the emit gate, then
 * exactly one of `done` or `error`. An `error` carries a stage and a code
 * from closed unions, never free text, model output, or a stack.
 */
export type PlanEvent =
  | { readonly event: "intent"; readonly data: Intent }
  | { readonly event: "itinerary"; readonly data: { readonly index: number; readonly option: ItineraryOption } }
  | { readonly event: "done"; readonly data: { readonly options: number; readonly itineraryIds: readonly string[] } }
  | {
      readonly event: "error";
      readonly data: PipelineFailure | { readonly stage: "internal"; readonly code: "internal_error" };
    };

export type PlanDepsFactory = () => PipelineDeps;

export interface PlanHandlerOptions {
  readonly store?: SpendStore;
  readonly now?: () => number;
  readonly persist?: PlanPersistence;
  /** Resolves the signed-in user for a request. A rejection persists the plan as anonymous. */
  readonly userId?: (request: Request) => Promise<string | null>;
  readonly metrics?: MetricsSink;
}

interface StreamMetrics {
  readonly sink: MetricsSink;
  readonly now: () => number;
  readonly capUsd: number;
  readonly precheck: MetricSample | null;
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
  persist: PlanPersistence | undefined,
): AsyncGenerator<PlanEvent> {
  const started = Date.now();
  const result = await runPipeline({ text, signal }, deps);
  if (spend) spend.auditModelUsd = result.audit.totalCostUsd;
  let itineraryIds: readonly string[] = [];
  if (persist && result.intent !== null) {
    const latencyMs = Math.max(0, Date.now() - started);
    try {
      const saved = await persist.save({
        rawText: text,
        intent: JSON.parse(JSON.stringify(result.intent)) as Record<string, unknown>,
        options:
          result.kind === "completed"
            ? result.options.map((emitted) => ({ optionIndex: emitted.optionIndex, option: emitted.option }))
            : [],
        promptVersions: deps.promptVersions,
        models: modelsFromCalls(result.audit.modelCalls),
        costUsd: result.audit.totalCostUsd,
        latencyMs,
      });
      itineraryIds = saved?.itineraryIds ?? [];
    } catch {
      // The plan already exists for this response. A database miss must not replace it with an error event.
    }
  }
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
  yield { event: "done", data: { options: result.options.length, itineraryIds } };
}

function outcomeFromError(
  data: PipelineFailure | { readonly stage: "internal"; readonly code: "internal_error" },
): PlanOutcome {
  if (data.stage === "internal") return { kind: "internal_error" };
  return { kind: "failed", failure: data };
}

function streamPlan(
  text: string,
  makeDeps: PlanDepsFactory,
  request: Request,
  onSpend: ((micros: number, keepZeroTotal: boolean) => Promise<number | null>) | undefined,
  persist: PlanPersistence | undefined,
  batch: StreamMetrics,
): Response {
  const cancelled = new AbortController();
  const signal = AbortSignal.any([request.signal, cancelled.signal]);
  const spend: RequestSpend | null = onSpend
    ? { modelUsd: 0, placesTextSearches: 0, routesHops: 0, auditModelUsd: null }
    : null;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let outcome: PlanOutcome | null = null;
      try {
        const deps = spend ? observeDeps(makeDeps(), spend) : makeDeps();
        for await (const event of planEvents(text, deps, signal, spend, persist)) {
          if (event.event === "done") outcome = { kind: "completed" };
          if (event.event === "error") outcome = outcomeFromError(event.data);
          controller.enqueue(frame(event));
        }
      } catch {
        if (!signal.aborted) {
          outcome = { kind: "internal_error" };
          controller.enqueue(frame({ event: "error", data: { stage: "internal", code: "internal_error" } }));
        }
      } finally {
        try {
          let added: number | null = null;
          if (onSpend && spend) {
            try {
              added = await onSpend(spendMicros(spend), outcome?.kind === "completed");
            } catch {
              // The plan already left this process. Losing the ledger write beats turning a finished stream into a 500.
            }
          }
          const samples: MetricSample[] = [];
          if (batch.precheck) samples.push(batch.precheck);
          if (added !== null) samples.push(spendFractionSample(added, batch.capUsd, batch.now()));
          if (outcome) samples.push(...planOutcomeSamples(outcome, batch.now()));
          await batch.sink.submit(samples);
        } finally {
          if (!cancelled.signal.aborted) controller.close();
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
  const sink = options.metrics ?? createNoopMetricsSink();
  const { persist: basePersist, userId: resolveUser } = options;
  return async (request) => {
    const persist: PlanPersistence | undefined =
      basePersist && resolveUser
        ? {
            async save(input) {
              const userId = await resolveUser(request).catch(() => null);
              return basePersist.save(userId ? { ...input, userId } : input);
            },
          }
        : basePersist;
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
    const parsed = planRequestSchema.safeParse(body);
    if (!parsed.success) {
      return badRequest("invalid_request");
    }
    const text = composePlanText(parsed.data);
    if (text.length > WRAP_USER_TEXT_MAX_CHARS) {
      return badRequest("invalid_request");
    }

    const store = options.store;
    if (!store) {
      return streamPlan(text, makeDeps, request, undefined, persist, {
        sink,
        now,
        capUsd: getRateLimitDailySpendUsd(),
        precheck: null,
      });
    }

    const at = now();
    const day = utcDay(at);
    const capUsd = getRateLimitDailySpendUsd();
    let spent: number;
    try {
      spent = await store.readDailyMicros(day);
    } catch {
      await sink.submit(planOutcomeSamples({ kind: "spend_cap_unavailable" }, at));
      return limitResponse("spend_cap_unavailable");
    }
    const precheck = spendFractionSample(spent, capUsd, at);
    if (spent >= usdToMicros(capUsd)) {
      await sink.submit([precheck]);
      return limitResponse("daily_spend_cap");
    }

    let count: number;
    try {
      count = await store.recordPlan(clientIp(request), at);
    } catch {
      await sink.submit([precheck, ...planOutcomeSamples({ kind: "spend_cap_unavailable" }, at)]);
      return limitResponse("spend_cap_unavailable");
    }
    if (count > getRateLimitRequestsPerHour()) {
      await sink.submit([precheck]);
      return limitResponse("hourly_plan_limit");
    }

    return streamPlan(
      text,
      makeDeps,
      request,
      async (micros, keepZeroTotal) => {
        if (micros > 0 || keepZeroTotal) return store.addDailyMicros(day, micros);
        return null;
      },
      persist,
      { sink, now, capUsd, precheck },
    );
  };
}

/** Production POST. The app route stays free of `src/monitoring` imports. */
export function createProductionPlanHandler(): (request: Request) => Promise<Response> {
  const db = createQueryableFromEnv();
  const auth = createGoTrueAuth();
  return createPlanHandler(() => createPipelineDeps(), {
    store: createSpendStoreFromEnv(),
    persist: db ? createPlanPersistence(db, getRequestHashSecret()) : undefined,
    userId: auth ? (request) => userIdFromRequest(request, auth) : undefined,
    metrics: createMetricsSinkFromEnv(),
  });
}
