import type { Intent } from "../../src/validation/intent";
import type { ItineraryOption } from "../../src/validation/itinerary";

declare const requestIdBrand: unique symbol;
/** Monotonic per page load. Built only by `nextRequestId`. */
export type RequestId = number & { readonly [requestIdBrand]: true };

let requestSequence = 0;

export function nextRequestId(): RequestId {
  requestSequence += 1;
  return requestSequence as RequestId;
}

export type OptionSlots = readonly [ItineraryOption | null, ItineraryOption | null, ItineraryOption | null];

export const EMPTY_SLOTS: OptionSlots = [null, null, null];

export type PlanFailureReason =
  | "request_rejected"
  | "no_candidates"
  | "no_valid_options"
  | "service_unavailable"
  | "connection_lost";

export const FAILURE_COPY: Readonly<Record<PlanFailureReason, string>> = {
  request_rejected: "That request couldn't be read. Try rephrasing it.",
  no_candidates: "We couldn't find open places that fit. Try another area or time.",
  no_valid_options: "Nothing we found passed our checks for that time. Try a different time or budget.",
  service_unavailable: "Planning is unavailable right now. Try again in a minute.",
  connection_lost: "The connection dropped before the plan finished. Try again.",
};

export type PlanState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "streaming";
      readonly requestId: RequestId;
      readonly intent: Intent | null;
      readonly options: OptionSlots;
    }
  | {
      readonly kind: "done";
      readonly requestId: RequestId;
      readonly intent: Intent;
      readonly options: OptionSlots;
    }
  | {
      readonly kind: "failed";
      readonly requestId: RequestId;
      readonly intent: Intent | null;
      readonly options: OptionSlots;
      readonly reason: PlanFailureReason;
    };

export const IDLE: PlanState = { kind: "idle" };

export type PlanUpdate =
  | { readonly kind: "intent"; readonly intent: Intent }
  | { readonly kind: "option"; readonly index: 0 | 1 | 2; readonly option: ItineraryOption }
  | { readonly kind: "done" }
  | { readonly kind: "failed"; readonly reason: PlanFailureReason };

export type PlanAction =
  | { readonly type: "submitted"; readonly requestId: RequestId }
  | { readonly type: "received"; readonly requestId: RequestId; readonly update: PlanUpdate };

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function withSlot(slots: OptionSlots, index: 0 | 1 | 2, option: ItineraryOption): OptionSlots {
  const next: [ItineraryOption | null, ItineraryOption | null, ItineraryOption | null] = [
    slots[0],
    slots[1],
    slots[2],
  ];
  next[index] = option;
  return next;
}

function applyUpdate(state: Extract<PlanState, { kind: "streaming" }>, update: PlanUpdate): PlanState {
  switch (update.kind) {
    case "intent":
      if (state.intent !== null && sameJson(state.intent, update.intent)) return state;
      return { ...state, intent: update.intent };
    case "option": {
      const current = state.options[update.index];
      if (current !== null && sameJson(current, update.option)) return state;
      return { ...state, options: withSlot(state.options, update.index, update.option) };
    }
    case "done":
      if (state.intent === null) {
        return {
          kind: "failed",
          requestId: state.requestId,
          intent: null,
          options: state.options,
          reason: "service_unavailable",
        };
      }
      return {
        kind: "done",
        requestId: state.requestId,
        intent: state.intent,
        options: state.options,
      };
    case "failed":
      return {
        kind: "failed",
        requestId: state.requestId,
        intent: state.intent,
        options: state.options,
        reason: update.reason,
      };
    default: {
      const unexpected: never = update;
      return unexpected;
    }
  }
}

export function planReducer(state: PlanState, action: PlanAction): PlanState {
  switch (action.type) {
    case "submitted":
      return {
        kind: "streaming",
        requestId: action.requestId,
        intent: null,
        options: EMPTY_SLOTS,
      };
    case "received": {
      if (state.kind !== "streaming" || state.requestId !== action.requestId) return state;
      return applyUpdate(state, action.update);
    }
    default: {
      const unexpected: never = action;
      return unexpected;
    }
  }
}
