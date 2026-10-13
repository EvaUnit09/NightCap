import { z } from "zod";

import { placeIdSchema } from "../validation/common";
import type { ReloadedStop } from "./request-screen-state";

const viewStopSchema = z.object({
  placeId: placeIdSchema,
  name: z.union([z.string().trim().min(1), z.null()]),
  why: z.string().trim().min(1),
  start: z.string().min(1),
});

const viewSchema = z.object({
  id: z.string().uuid(),
  stops: z.array(viewStopSchema),
});

export type ItineraryLoad =
  | { readonly kind: "ready"; readonly id: string; readonly stops: readonly ReloadedStop[] }
  | { readonly kind: "missing" };

export async function loadItinerary(
  id: string,
  options: { readonly signal?: AbortSignal; readonly fetchImpl?: typeof fetch } = {},
): Promise<ItineraryLoad> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`/api/itineraries/${encodeURIComponent(id)}`, {
      headers: { accept: "application/json" },
      signal: options.signal,
    });
    if (!response.ok) return { kind: "missing" };
    const body: unknown = await response.json();
    const parsed = viewSchema.safeParse(body);
    if (!parsed.success) return { kind: "missing" };
    return {
      kind: "ready",
      id: parsed.data.id,
      stops: parsed.data.stops.map((stop) => ({
        placeId: stop.placeId,
        name: stop.name,
        why: stop.why,
        start: stop.start,
      })),
    };
  } catch {
    if (options.signal?.aborted) return { kind: "missing" };
    return { kind: "missing" };
  }
}
