import { z } from "zod";

import type { LatLng } from "../retrieval";
import { placeIdSchema } from "../validation/common";
import { readJsonBody } from "./read-json-body";

const JSON_HEADERS = { "Cache-Control": "no-store" } as const;
const BODY_MAX_CHARS = 8_000;

const bodySchema = z
  .object({
    placeIds: z.array(placeIdSchema).max(24),
  })
  .strict();

export type ReadLiveCoords = (placeIds: readonly string[], now: Date) => Promise<ReadonlyMap<string, LatLng>>;

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: JSON_HEADERS });
}

function uniquePlaceIds(placeIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const placeId of placeIds) {
    if (seen.has(placeId)) continue;
    seen.add(placeId);
    unique.push(placeId);
  }
  return unique;
}

export function createMapCoordsHandler(
  read: ReadLiveCoords,
  now: () => Date = () => new Date(),
): (request: Request) => Promise<Response> {
  return async (request) => {
    const body = await readJsonBody(request, BODY_MAX_CHARS);
    if (body instanceof Response) return body;
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) return json({ error: "invalid_request" }, 400);
    const placeIds = uniquePlaceIds(parsed.data.placeIds);
    if (placeIds.length === 0) return json({ coords: [] }, 200);
    let found: ReadonlyMap<string, LatLng>;
    try {
      found = await read(placeIds, now());
    } catch {
      return json({ coords: [] }, 200);
    }
    const coords = placeIds.flatMap((placeId) => {
      const hit = found.get(placeId);
      if (!hit || !Number.isFinite(hit.lat) || !Number.isFinite(hit.lng)) return [];
      return [{ placeId, lat: hit.lat, lng: hit.lng }];
    });
    return json({ coords }, 200);
  };
}
