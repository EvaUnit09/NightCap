import type { ScreenModel } from "./request-screen-state";

export interface MapStop {
  readonly placeId: string;
  readonly label: string;
}

export interface MapCoord {
  readonly placeId: string;
  readonly lat: number;
  readonly lng: number;
}

export interface MapMarker {
  readonly placeId: string;
  readonly label: string;
  readonly order: number;
  readonly lat: number;
  readonly lng: number;
}

export interface MapOption {
  readonly stops: readonly { readonly placeId: string; readonly name: string }[];
}

export function markersFromStops(stops: readonly MapStop[], coords: readonly MapCoord[]): readonly MapMarker[] {
  const byPlace = new Map(coords.map((coord) => [coord.placeId, coord]));
  const markers: MapMarker[] = [];
  stops.forEach((stop, index) => {
    const coord = byPlace.get(stop.placeId);
    if (!coord || !Number.isFinite(coord.lat) || !Number.isFinite(coord.lng)) return;
    markers.push({
      placeId: stop.placeId,
      label: stop.label,
      order: index + 1,
      lat: coord.lat,
      lng: coord.lng,
    });
  });
  return markers;
}

export function clampSelection(index: number, count: number): number {
  if (count <= 0 || !Number.isInteger(index) || index < 0) return 0;
  return Math.min(index, count - 1);
}

export function stopsForSelection(options: readonly MapOption[], selectedIndex: number): readonly MapStop[] {
  const option = options[clampSelection(selectedIndex, options.length)];
  if (!option || options.length === 0) return [];
  return option.stops.map((stop) => ({ placeId: stop.placeId, label: stop.name }));
}

export function mapOptionsForScreen(screen: ScreenModel): readonly MapOption[] {
  switch (screen.phase) {
    case "planning":
    case "ready":
      return screen.options.map((option) => ({
        stops: option.stops.map((stop) => ({ placeId: stop.placeId, name: stop.name })),
      }));
    case "reloaded":
      return [
        {
          stops: screen.stops.map((stop) => ({
            placeId: stop.placeId,
            name: stop.name ?? stop.placeId,
          })),
        },
      ];
    case "idle":
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
