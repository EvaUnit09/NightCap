import { z } from "zod";

import type { PlaceDetailsLookup, PlaceLiveDetails } from "../monitoring/hydrate-plan";
import { placeIdSchema, priceLevelSchema } from "../validation/common";
import { PlacesError } from "./places-client";

export const PLACES_DETAILS_FIELD_MASK = "id,displayName,formattedAddress,rating,priceLevel";

const detailsWireSchema = z.object({
  id: placeIdSchema,
  displayName: z.object({ text: z.string().trim().min(1) }),
  formattedAddress: z.string().trim().min(1).optional(),
  rating: z.number().optional(),
  priceLevel: priceLevelSchema.optional(),
});

export function parsePlaceDetails(raw: unknown): PlaceLiveDetails | null {
  const wire = detailsWireSchema.safeParse(raw);
  if (!wire.success) return null;
  return {
    placeId: wire.data.id,
    name: wire.data.displayName.text,
    formattedAddress: wire.data.formattedAddress ?? null,
    rating: wire.data.rating ?? null,
    priceLevel: wire.data.priceLevel ?? null,
  };
}

export interface PlaceDetailsClientOptions {
  readonly apiKey: string | undefined;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

function detailsUrl(placeId: string): string {
  return `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;
}

async function readDetails(response: Response): Promise<PlaceLiveDetails | null> {
  if (response.status === 404) return null;
  if (response.status === 429) throw new PlacesError("rate_limited", "Places HTTP 429");
  if (!response.ok) throw new PlacesError("http_error", `Places HTTP ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PlacesError("malformed", "Places body is not JSON");
  }
  return parsePlaceDetails(body);
}

export function createPlacesDetailsLookup(options: PlaceDetailsClientOptions): PlaceDetailsLookup {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async lookup(placeIds) {
      if (!options.apiKey) {
        throw new PlacesError("missing_key", "GOOGLE_PLACES_API_KEY is missing");
      }
      const unique = [...new Set(placeIds)];
      const pairs = await Promise.all(
        unique.map(async (placeId) => {
          try {
            const response = await fetchImpl(detailsUrl(placeId), {
              method: "GET",
              headers: {
                "X-Goog-Api-Key": options.apiKey ?? "",
                "X-Goog-FieldMask": PLACES_DETAILS_FIELD_MASK,
              },
              signal: AbortSignal.timeout(options.timeoutMs),
            });
            const details = await readDetails(response);
            return details ? ([details.placeId, details] as const) : null;
          } catch (error) {
            if (error instanceof PlacesError && error.code !== "missing_key") return null;
            if (error instanceof PlacesError) throw error;
            return null;
          }
        }),
      );
      return new Map(pairs.filter((pair): pair is readonly [string, PlaceLiveDetails] => pair !== null));
    },
  };
}
