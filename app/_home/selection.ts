import { clampSelection, stopsForSelection, type MapStop } from "../../src/client/map-markers";
import type { ItineraryOption } from "../../src/validation/itinerary";
import type { OptionSlots, PlanState } from "./plan-state";

export type DonePlan = Extract<PlanState, { kind: "done" }>;

export interface SelectedNight {
  /** Clamped to the filled options. 0 when there are none. */
  readonly index: number;
  /** Selected option's stops in order, `label` = stop name. */
  readonly mapStops: readonly MapStop[];
  /** `itineraryIds[index]` only when ids align 1:1 with filled options. */
  readonly itineraryId: string | undefined;
}

export function filledOptions(slots: OptionSlots): readonly ItineraryOption[] {
  const options: ItineraryOption[] = [];
  for (const slot of slots) {
    if (slot === null) break;
    options.push(slot);
  }
  return options;
}

export function selectNight(plan: DonePlan, requested: number): SelectedNight {
  const options = filledOptions(plan.options);
  const index = clampSelection(requested, options.length);
  const mapStops = stopsForSelection(
    options.map((option) => ({
      stops: option.stops.map((stop) => ({ placeId: stop.placeId, name: stop.name })),
    })),
    index,
  );
  const itineraryId =
    plan.itineraryIds.length === options.length && options.length > 0
      ? plan.itineraryIds[index]
      : undefined;
  return { index, mapStops, itineraryId };
}
