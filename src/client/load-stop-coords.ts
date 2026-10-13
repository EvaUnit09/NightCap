import { z } from "zod";

import { placeIdSchema } from "../validation/common";
import type { MapCoord } from "./map-markers";

const responseSchema = z
  .object({
    coords: z.array(
      z
        .object({
          placeId: placeIdSchema,
          lat: z.number().finite(),
          lng: z.number().finite(),
        })
        .strict(),
    ),
  })
  .strict();

export async function loadStopCoords(
  placeIds: readonly string[],
  options: { readonly signal?: AbortSignal; readonly fetchImpl?: typeof fetch } = {},
): Promise<readonly MapCoord[]> {
  if (placeIds.length === 0) return [];
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl("/api/map-coords", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ placeIds }),
      signal: options.signal,
    });
    if (!response.ok) return [];
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) return [];
    return parsed.data.coords;
  } catch {
    return [];
  }
}
