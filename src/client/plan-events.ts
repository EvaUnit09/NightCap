import { z } from "zod";

import type { PlanRequest } from "../api/plan-request";
import { intentSchema, type Intent } from "../validation/intent";
import { itineraryOptionSchemaFor, type ItineraryOption } from "../validation/itinerary";

const itineraryFrameSchema = z
  .object({
    index: z.int().nonnegative(),
    option: z.union([itineraryOptionSchemaFor(false), itineraryOptionSchemaFor(true)]),
  })
  .strict();

const doneFrameSchema = z
  .object({
    options: z.int().nonnegative(),
    itineraryIds: z.array(z.string().uuid()).optional(),
  })
  .strict();

const failureSchema = z.discriminatedUnion("stage", [
  z.object({ stage: z.literal("redact"), code: z.string().min(1).max(80) }).strict(),
  z.object({ stage: z.literal("parse"), code: z.string().min(1).max(80) }).strict(),
  z.object({ stage: z.literal("retrieve"), code: z.string().min(1).max(80) }).strict(),
  z.object({ stage: z.literal("plan"), code: z.string().min(1).max(80) }).strict(),
  z.object({ stage: z.literal("validate"), code: z.literal("no_valid_options") }).strict(),
  z.object({ stage: z.literal("internal"), code: z.literal("internal_error") }).strict(),
]);

const limitSchema = z.object({
  error: z.enum(["daily_spend_cap", "hourly_plan_limit", "spend_cap_unavailable"]),
  message: z.string().min(1).optional(),
});

export interface PlanEmit {
  onIntent(intent: Intent): void;
  onItinerary(option: ItineraryOption): void;
  onDone(itineraryIds: readonly string[]): void;
  onFailed(code: string): void;
}

export type PlanOutcome =
  | { readonly kind: "streamed" }
  | { readonly kind: "daily_spend_cap"; readonly message: string }
  | { readonly kind: "hourly_plan_limit"; readonly message: string }
  | { readonly kind: "unavailable" }
  | { readonly kind: "rejected"; readonly status: number }
  | { readonly kind: "aborted" };

const DAILY_MESSAGE = "Come back tomorrow.";
const HOURLY_MESSAGE = "Too many plans from this network. Try again in an hour.";

type FrameStep = "ok" | "terminal" | "invalid";

function applyFrame(event: string, data: string, emit: PlanEmit): FrameStep {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return "invalid";
  }
  switch (event) {
    case "intent": {
      const parsed = intentSchema.safeParse(payload);
      if (!parsed.success) return "invalid";
      emit.onIntent(parsed.data);
      return "ok";
    }
    case "itinerary": {
      const parsed = itineraryFrameSchema.safeParse(payload);
      if (!parsed.success) return "invalid";
      emit.onItinerary(parsed.data.option);
      return "ok";
    }
    case "done": {
      const parsed = doneFrameSchema.safeParse(payload);
      if (!parsed.success) return "invalid";
      emit.onDone(parsed.data.itineraryIds ?? []);
      return "terminal";
    }
    case "error": {
      const parsed = failureSchema.safeParse(payload);
      if (!parsed.success) return "invalid";
      emit.onFailed(parsed.data.code);
      return "terminal";
    }
    default:
      return "invalid";
  }
}

function takeFrame(frame: string): { event: string; data: string } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

async function readFrames(
  body: ReadableStream<Uint8Array>,
  onFrame: (event: string, data: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const drain = (final: boolean) => {
    if (final) buffer += decoder.decode();
    let split = buffer.indexOf("\n\n");
    while (split !== -1) {
      const frame = takeFrame(buffer.slice(0, split));
      buffer = buffer.slice(split + 2);
      if (frame) onFrame(frame.event, frame.data);
      split = buffer.indexOf("\n\n");
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      drain(true);
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    drain(false);
  }
}

/**
 * POST /api/plan cannot be an EventSource. The browser has to send a JSON body,
 * so this reads the SSE bytes from fetch.
 */
export async function consumePlanResponse(response: Response, emit: PlanEmit): Promise<PlanOutcome> {
  if (response.status === 429) {
    const body: unknown = await response.json().catch(() => null);
    const parsed = limitSchema.safeParse(body);
    if (!parsed.success) return { kind: "rejected", status: 429 };
    switch (parsed.data.error) {
      case "daily_spend_cap":
        return { kind: "daily_spend_cap", message: parsed.data.message ?? DAILY_MESSAGE };
      case "hourly_plan_limit":
        return { kind: "hourly_plan_limit", message: parsed.data.message ?? HOURLY_MESSAGE };
      case "spend_cap_unavailable":
        return { kind: "unavailable" };
      default: {
        const neverError: never = parsed.data.error;
        return neverError;
      }
    }
  }
  if (response.status === 503) return { kind: "unavailable" };
  if (!response.ok || response.body === null) return { kind: "rejected", status: response.status };
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) return { kind: "rejected", status: response.status };

  let terminal = false;
  await readFrames(response.body, (event, data) => {
    if (terminal) return;
    const step = applyFrame(event, data, emit);
    if (step === "invalid") {
      emit.onFailed("invalid_event");
      terminal = true;
      return;
    }
    if (step === "terminal") terminal = true;
  });
  if (!terminal) emit.onFailed("stream_closed");
  return { kind: "streamed" };
}

export async function requestPlan(
  input: PlanRequest,
  emit: PlanEmit,
  options: { readonly signal?: AbortSignal; readonly fetchImpl?: typeof fetch } = {},
): Promise<PlanOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(input),
      signal: options.signal,
    });
    return await consumePlanResponse(response, emit);
  } catch {
    if (options.signal?.aborted) return { kind: "aborted" };
    return { kind: "unavailable" };
  }
}
