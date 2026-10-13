import "server-only";

import { z } from "zod";

import { createGoTrueAuth, userIdFromRequest, type MagicLinkAuth } from "../auth/magic-link";
import { createQueryableFromEnv } from "../db/postgres";
import { getRateLimitDailySpendUsd } from "../models/config";
import {
  hydrateStoredStops,
  type HydratedStop,
  type PlaceDetailsLookup,
} from "../monitoring/hydrate-plan";
import { usdToMicros, utcDay } from "../monitoring/spend-cap";
import { createSpendStoreFromEnv } from "../monitoring/spend-store";
import type { Queryable } from "../monitoring/store-request";
import { storedStopSchema, type StoredStop } from "../monitoring/stored-stop";
import { createPlaceDetailsLookupFromEnv } from "../retrieval";

const JSON_HEADERS = { "Cache-Control": "no-store" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHARE_SLUG = /^[A-Za-z0-9_-]{16,64}$/;
const CLIENT_SLUG_KEYS = ["shareSlug", "share_slug", "slug"] as const;

const sharedRowSchema = z.object({
  itinerary_id: z.string().uuid(),
  option_index: z.number().int(),
  stops: z.array(storedStopSchema),
  valid: z.boolean(),
});

const savedRowSchema = z.object({
  id: z.string().uuid(),
  share_slug: z.string().regex(SHARE_SLUG),
});

export interface SharedPlanView {
  readonly itineraryId: string;
  readonly optionIndex: number;
  readonly storedStops: readonly StoredStop[];
  readonly stops: readonly HydratedStop[];
  readonly hydrated: boolean;
}

export interface SaveDeps {
  readonly db: Queryable;
  readonly userId: (request: Request) => Promise<string | null>;
}

export interface SharedReadDeps {
  readonly db: Queryable;
  readonly lookup: PlaceDetailsLookup;
  readonly placesBlocked: () => Promise<boolean>;
}

export type SharedPage =
  | { readonly status: "unconfigured" }
  | { readonly status: "missing" }
  | { readonly status: "ready"; readonly view: SharedPlanView };

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: JSON_HEADERS });
}

export function isShareSlug(slug: string): boolean {
  return SHARE_SLUG.test(slug);
}

function parseSaveBody(raw: unknown): { ok: true; itineraryId: string } | { ok: false; error: "invalid_request" | "client_slug" } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "invalid_request" };
  const body = raw as Record<string, unknown>;
  for (const key of CLIENT_SLUG_KEYS) {
    if (key in body) return { ok: false, error: "client_slug" };
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "itineraryId") return { ok: false, error: "invalid_request" };
  if (typeof body.itineraryId !== "string" || !UUID.test(body.itineraryId)) return { ok: false, error: "invalid_request" };
  return { ok: true, itineraryId: body.itineraryId };
}

function saveFailure(error: unknown): "not_found" | "forbidden" | "failed" {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("itinerary not found")) return "not_found";
  if (message.includes("cannot save another user's itinerary")) return "forbidden";
  return "failed";
}

function withoutNames(stops: readonly StoredStop[]): HydratedStop[] {
  return stops.map((stop) => ({
    ...stop,
    name: null,
    formattedAddress: null,
    rating: null,
    priceLevel: null,
  }));
}

function stopsFromRow(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

async function readSharedRow(db: Queryable, slug: string): Promise<z.infer<typeof sharedRowSchema> | null> {
  if (!isShareSlug(slug)) return null;
  const selected = await db.query<Record<string, unknown>>(`SELECT * FROM public.get_shared_plan($1)`, [slug]);
  const row = selected.rows[0];
  if (!row) return null;
  const parsed = sharedRowSchema.safeParse({ ...row, stops: stopsFromRow(row.stops) });
  if (!parsed.success || !parsed.data.valid) return null;
  return parsed.data;
}

export function createSavePlanHandler(deps: SaveDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const raw = await request.text().catch(() => null);
    if (raw === null) return json({ error: "invalid_request" }, 400);
    if (raw.length > 4000) return json({ error: "too_large" }, 400);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const parsed = parseSaveBody(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);

    const userId = await deps.userId(request);
    if (!userId) return json({ error: "sign_in_required" }, 401);

    const existing = await deps.db.query<{ id: string; share_slug: string }>(
      `SELECT id, share_slug
       FROM public.saved_plans
       WHERE user_id = $1 AND itinerary_id = $2
       ORDER BY created_at ASC
       LIMIT 1`,
      [userId, parsed.itineraryId],
    );
    const already = existing.rows[0];
    if (already && isShareSlug(already.share_slug)) {
      return json({ id: already.id, shareSlug: already.share_slug, sharePath: `/s/${already.share_slug}` }, 200);
    }

    try {
      const saved = await deps.db.query<{ id: string; share_slug: string }>(
        `SELECT * FROM public.save_plan($1, $2)`,
        [userId, parsed.itineraryId],
      );
      const row = savedRowSchema.parse(saved.rows[0]);
      return json({ id: row.id, shareSlug: row.share_slug, sharePath: `/s/${row.share_slug}` }, 201);
    } catch (error) {
      const failure = saveFailure(error);
      switch (failure) {
        case "not_found":
          return json({ error: "not_found" }, 404);
        case "forbidden":
          return json({ error: "forbidden" }, 403);
        case "failed":
          return json({ error: "save_failed" }, 500);
        default: {
          const neverFailure: never = failure;
          return neverFailure;
        }
      }
    }
  };
}

export function createSharedPlanReader(deps: SharedReadDeps): (slug: string) => Promise<SharedPlanView | null> {
  return async (slug) => {
    const row = await readSharedRow(deps.db, slug);
    if (!row) return null;
    const storedStops = row.stops;
    let blocked = true;
    try {
      blocked = await deps.placesBlocked();
    } catch {
      blocked = true;
    }
    if (blocked) {
      return {
        itineraryId: row.itinerary_id,
        optionIndex: row.option_index,
        storedStops,
        stops: withoutNames(storedStops),
        hydrated: false,
      };
    }
    try {
      const stops = await hydrateStoredStops(storedStops, deps.lookup);
      return {
        itineraryId: row.itinerary_id,
        optionIndex: row.option_index,
        storedStops,
        stops,
        hydrated: true,
      };
    } catch {
      return {
        itineraryId: row.itinerary_id,
        optionIndex: row.option_index,
        storedStops,
        stops: withoutNames(storedStops),
        hydrated: false,
      };
    }
  };
}

export function createSharedPlanHandler(deps: SharedReadDeps): (slug: string) => Promise<Response> {
  const read = createSharedPlanReader(deps);
  return async (slug) => {
    const view = await read(slug);
    if (!view) return json({ error: "not_found" }, 404);
    return json(view, 200);
  };
}

async function placesBlocked(): Promise<boolean> {
  try {
    const spent = await createSpendStoreFromEnv().readDailyMicros(utcDay(Date.now()));
    return spent >= usdToMicros(getRateLimitDailySpendUsd());
  } catch {
    return true;
  }
}

function productionReader(db: Queryable): (slug: string) => Promise<SharedPlanView | null> {
  return createSharedPlanReader({
    db,
    lookup: createPlaceDetailsLookupFromEnv(),
    placesBlocked,
  });
}

export function createProductionSaveHandler(): (request: Request) => Promise<Response> {
  const db = createQueryableFromEnv();
  const auth: MagicLinkAuth | null = createGoTrueAuth();
  if (!db) return async () => json({ error: "persist_unconfigured" }, 503);
  if (!auth) return async () => json({ error: "auth_unconfigured" }, 503);
  return createSavePlanHandler({
    db,
    userId: (request) => userIdFromRequest(request, auth),
  });
}

export function createProductionSharedPlanHandler(): (slug: string) => Promise<Response> {
  const db = createQueryableFromEnv();
  const read = db ? productionReader(db) : null;
  return async (slug) => {
    if (!isShareSlug(slug)) return json({ error: "not_found" }, 404);
    if (!read) return json({ error: "persist_unconfigured" }, 503);
    const view = await read(slug);
    if (!view) return json({ error: "not_found" }, 404);
    return json(view, 200);
  };
}

export async function loadSharedPlanPage(slug: string): Promise<SharedPage> {
  if (!isShareSlug(slug)) return { status: "missing" };
  const db = createQueryableFromEnv();
  if (!db) return { status: "unconfigured" };
  const view = await productionReader(db)(slug);
  if (!view) return { status: "missing" };
  return { status: "ready", view };
}
