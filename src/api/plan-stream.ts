import "server-only";

import { z } from "zod";

import { runPipeline, WRAP_USER_TEXT_MAX_CHARS, type PipelineDeps, type PipelineFailure } from "../pipeline";
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
async function* planEvents(text: string, deps: PipelineDeps, signal: AbortSignal): AsyncGenerator<PlanEvent> {
  const result = await runPipeline({ text, signal }, deps);
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

function streamPlan(text: string, makeDeps: PlanDepsFactory, request: Request): Response {
  const cancelled = new AbortController();
  const signal = AbortSignal.any([request.signal, cancelled.signal]);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of planEvents(text, makeDeps(), signal)) {
          controller.enqueue(frame(event));
        }
      } catch {
        if (!signal.aborted) {
          controller.enqueue(frame({ event: "error", data: { stage: "internal", code: "internal_error" } }));
        }
      }
      if (!cancelled.signal.aborted) {
        controller.close();
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
export function createPlanHandler(makeDeps: PlanDepsFactory): (request: Request) => Promise<Response> {
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
    return streamPlan(parsed.data.text, makeDeps, request);
  };
}
