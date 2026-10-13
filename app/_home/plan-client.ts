import { z } from "zod";

import type { PipelineFailure } from "../../src/pipeline/lifecycle";
import { intentSchema, type Intent } from "../../src/validation/intent";
import { itineraryOptionSchemaFor, type ItineraryOption } from "../../src/validation/itinerary";
import { type OptionSlots, type PlanFailureReason, type PlanUpdate } from "./plan-state";

type WireErrorStage = PipelineFailure["stage"] | "internal";

const WIRE_ERROR_STAGES = {
  redact: true,
  parse: true,
  retrieve: true,
  plan: true,
  validate: true,
  internal: true,
} as const satisfies Record<WireErrorStage, true>;

function isWireErrorStage(value: string): value is WireErrorStage {
  return Object.prototype.hasOwnProperty.call(WIRE_ERROR_STAGES, value);
}

const errorEnvelopeSchema = z.object({ stage: z.string(), code: z.string() }).strict();
const doneSchema = z.object({ options: z.number().int().nonnegative() }).strict();

export function toFailureReason(stage: WireErrorStage, code: string): PlanFailureReason {
  switch (stage) {
    case "retrieve":
      return code === "no_candidates" ? "no_candidates" : "service_unavailable";
    case "validate":
      return "no_valid_options";
    case "redact":
      return code === "too_long" ? "request_rejected" : "service_unavailable";
    case "parse":
    case "plan":
    case "internal":
      return "service_unavailable";
    default: {
      const unexpected: never = stage;
      return unexpected;
    }
  }
}

interface SseFrame {
  readonly event: string;
  readonly data: string;
}

export interface SseFrameParser {
  push(chunk: string): readonly SseFrame[];
  end(): { readonly leftover: boolean };
}

function parseBlock(raw: string): SseFrame | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

export function createSseFrameParser(): SseFrameParser {
  let buffer = "";
  return {
    push(chunk: string): readonly SseFrame[] {
      buffer += chunk;
      const held = buffer.endsWith("\r") ? "\r" : "";
      const source = held ? buffer.slice(0, -1) : buffer;
      let text = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
      const frames: SseFrame[] = [];
      while (true) {
        const separator = text.indexOf("\n\n");
        if (separator === -1) break;
        const frame = parseBlock(text.slice(0, separator));
        text = text.slice(separator + 2);
        if (frame) frames.push(frame);
      }
      buffer = text + held;
      return frames;
    },
    end() {
      const leftover = buffer.trim().length > 0;
      buffer = "";
      return { leftover };
    },
  };
}

function parseData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function failed(reason: PlanFailureReason): PlanUpdate {
  return { kind: "failed", reason };
}

export function toPlanUpdate(frame: SseFrame, intentSoFar: Intent | null): PlanUpdate {
  const payload = parseData(frame.data);
  if (payload === undefined) return failed("service_unavailable");
  switch (frame.event) {
    case "intent": {
      const parsed = intentSchema.safeParse(payload);
      if (!parsed.success) return failed("service_unavailable");
      return { kind: "intent", intent: parsed.data };
    }
    case "itinerary": {
      const parsed = z
        .object({
          index: z.union([z.literal(0), z.literal(1), z.literal(2)]),
          option: itineraryOptionSchemaFor(intentSoFar?.singleStop === true),
        })
        .strict()
        .safeParse(payload);
      if (!parsed.success) return failed("service_unavailable");
      return { kind: "option", index: parsed.data.index, option: parsed.data.option };
    }
    case "done": {
      if (!doneSchema.safeParse(payload).success) return failed("service_unavailable");
      return { kind: "done" };
    }
    case "error": {
      const parsed = errorEnvelopeSchema.safeParse(payload);
      if (!parsed.success || !isWireErrorStage(parsed.data.stage)) return failed("service_unavailable");
      return failed(toFailureReason(parsed.data.stage, parsed.data.code));
    }
    default:
      return failed("service_unavailable");
  }
}

function placeOption(slots: OptionSlots, index: 0 | 1 | 2, option: ItineraryOption): OptionSlots {
  const next: [ItineraryOption | null, ItineraryOption | null, ItineraryOption | null] = [
    slots[0],
    slots[1],
    slots[2],
  ];
  next[index] = option;
  return next;
}

function receivedSlotsMatch(slots: OptionSlots, count: number): boolean {
  let filled = 0;
  for (const slot of slots) {
    if (slot !== null) filled += 1;
  }
  if (filled !== count) return false;
  for (let index = 0; index < slots.length; index += 1) {
    if ((slots[index] !== null) !== index < count) return false;
  }
  return true;
}

function isAbort(signal: AbortSignal, error: unknown): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

export async function* streamPlan(
  text: string,
  signal: AbortSignal,
): AsyncGenerator<PlanUpdate, void, undefined> {
  if (signal.aborted) return;
  let response: Response;
  try {
    response = await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ text }),
      signal,
    });
  } catch (error) {
    if (isAbort(signal, error)) return;
    yield failed("service_unavailable");
    return;
  }
  if (signal.aborted) return;
  if (response.status === 400) {
    yield failed("request_rejected");
    return;
  }
  if (!response.ok || response.body === null) {
    yield failed("service_unavailable");
    return;
  }

  const parser = createSseFrameParser();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let intent: Intent | null = null;
  let slots: OptionSlots = [null, null, null];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) return;
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const frame of parser.push(chunk)) {
        const update = toPlanUpdate(frame, intent);
        if (update.kind === "intent") intent = update.intent;
        if (update.kind === "option") slots = placeOption(slots, update.index, update.option);
        if (update.kind === "done") {
          const parsed = doneSchema.safeParse(parseData(frame.data));
          if (!parsed.success || !receivedSlotsMatch(slots, parsed.data.options)) {
            yield failed("connection_lost");
            return;
          }
        }
        yield update;
        if (update.kind === "done" || update.kind === "failed") return;
      }
    }
    decoder.decode();
    parser.end();
    if (signal.aborted) return;
    yield failed("connection_lost");
  } catch (error) {
    if (isAbort(signal, error)) return;
    yield failed("service_unavailable");
  }
}
