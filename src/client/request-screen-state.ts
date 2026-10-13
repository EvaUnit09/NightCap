import type { Intent } from "../validation/intent";
import type { ItineraryOption } from "../validation/itinerary";

export interface ReloadedStop {
  readonly placeId: string;
  readonly name: string | null;
  readonly why: string;
  readonly start: string;
}

export type ScreenModel =
  | { readonly phase: "idle" }
  | { readonly phase: "planning"; readonly intent: Intent | null; readonly options: readonly ItineraryOption[] }
  | {
      readonly phase: "ready";
      readonly intent: Intent | null;
      readonly options: readonly ItineraryOption[];
      readonly itineraryIds: readonly string[];
    }
  | { readonly phase: "daily_spend_cap"; readonly message: string }
  | { readonly phase: "hourly_plan_limit"; readonly message: string }
  | { readonly phase: "unavailable" }
  | { readonly phase: "rejected" }
  | { readonly phase: "failed"; readonly code: string }
  | { readonly phase: "reloading" }
  | { readonly phase: "reloaded"; readonly id: string; readonly stops: readonly ReloadedStop[] }
  | { readonly phase: "reload_missing" };

export type ScreenEvent =
  | { readonly type: "submit" }
  | { readonly type: "intent"; readonly intent: Intent }
  | { readonly type: "itinerary"; readonly option: ItineraryOption }
  | { readonly type: "done"; readonly itineraryIds: readonly string[] }
  | { readonly type: "daily_spend_cap"; readonly message: string }
  | { readonly type: "hourly_plan_limit"; readonly message: string }
  | { readonly type: "unavailable" }
  | { readonly type: "rejected" }
  | { readonly type: "failed"; readonly code: string }
  | { readonly type: "reload_start" }
  | { readonly type: "reload_ready"; readonly id: string; readonly stops: readonly ReloadedStop[] }
  | { readonly type: "reload_missing" };

export function initialScreen(itineraryId: string | undefined): ScreenModel {
  return itineraryId ? { phase: "reloading" } : { phase: "idle" };
}

export function reduceScreen(state: ScreenModel, event: ScreenEvent): ScreenModel {
  switch (event.type) {
    case "submit":
      return { phase: "planning", intent: null, options: [] };
    case "intent":
      if (state.phase !== "planning") return state;
      return { ...state, intent: event.intent };
    case "itinerary":
      if (state.phase !== "planning") return state;
      return { ...state, options: [...state.options, event.option] };
    case "done":
      if (state.phase !== "planning") return state;
      return { phase: "ready", intent: state.intent, options: state.options, itineraryIds: event.itineraryIds };
    case "daily_spend_cap":
      return { phase: "daily_spend_cap", message: event.message };
    case "hourly_plan_limit":
      return { phase: "hourly_plan_limit", message: event.message };
    case "unavailable":
      return { phase: "unavailable" };
    case "rejected":
      return { phase: "rejected" };
    case "failed":
      return { phase: "failed", code: event.code };
    case "reload_start":
      if (state.phase === "planning") return state;
      return { phase: "reloading" };
    case "reload_ready":
      if (state.phase !== "reloading") return state;
      return { phase: "reloaded", id: event.id, stops: event.stops };
    case "reload_missing":
      if (state.phase !== "reloading") return state;
      return { phase: "reload_missing" };
    default: {
      const neverEvent: never = event;
      return neverEvent;
    }
  }
}

export interface FeedbackTarget {
  readonly itineraryId: string;
  readonly placeIds: readonly string[];
}

export function feedbackTargets(screen: ScreenModel): readonly FeedbackTarget[] {
  switch (screen.phase) {
    case "ready": {
      if (screen.itineraryIds.length === 0 || screen.itineraryIds.length !== screen.options.length) return [];
      const targets: FeedbackTarget[] = [];
      for (let index = 0; index < screen.options.length; index += 1) {
        const itineraryId = screen.itineraryIds[index];
        const option = screen.options[index];
        if (!itineraryId || !option) return [];
        targets.push({ itineraryId, placeIds: option.stops.map((stop) => stop.placeId) });
      }
      return targets;
    }
    case "reloaded":
      return [{ itineraryId: screen.id, placeIds: screen.stops.map((stop) => stop.placeId) }];
    case "idle":
    case "planning":
    case "daily_spend_cap":
    case "hourly_plan_limit":
    case "unavailable":
    case "rejected":
    case "failed":
    case "reloading":
    case "reload_missing":
      return [];
    default: {
      const neverScreen: never = screen;
      return neverScreen;
    }
  }
}
