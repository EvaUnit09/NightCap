import { costUsdFor } from "../models/pricing";
import { PLACES_TEXT_SEARCH_MICROS, ROUTES_ESSENTIALS_HOP_MICROS } from "../monitoring/spend-cap";

const MICROS_PER_USD = 1_000_000;

export function placesCostUsd(placesRequests: number): number {
  return (placesRequests * PLACES_TEXT_SEARCH_MICROS) / MICROS_PER_USD;
}

export function routesCostUsd(routesHops: number): number {
  return (routesHops * ROUTES_ESSENTIALS_HOP_MICROS) / MICROS_PER_USD;
}

export function modelCostUsd(
  model: string,
  usage: { readonly inputTokens: number; readonly outputTokens: number },
): number {
  return costUsdFor(model, usage) ?? 0;
}

export function turnCostUsd(parts: {
  readonly modelUsd: number;
  readonly placesRequests: number;
  readonly routesHops: number;
}): number {
  return parts.modelUsd + placesCostUsd(parts.placesRequests) + routesCostUsd(parts.routesHops);
}
