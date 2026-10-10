import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { asRole, expectPermissionDenied, expectRejects } from "./harness";

type Seed = {
  userAId: string;
  userBId: string;
  requestAId: string;
  itineraryAId: string;
  itineraryInvalidId: string;
  slug: string;
};

async function seed(db: PGlite): Promise<Seed> {
  const userA = await db.query<{ id: string }>(
    `INSERT INTO auth.users (email) VALUES ('invar-a@test.com') RETURNING id`
  );
  const userB = await db.query<{ id: string }>(
    `INSERT INTO auth.users (email) VALUES ('invar-b@test.com') RETURNING id`
  );
  const userAId = userA.rows[0].id;
  const userBId = userB.rows[0].id;

  const request = await db.query<{ id: string }>(
    `INSERT INTO public.requests (user_id, redacted_text, parsed_intent)
     VALUES ($1, 'redacted', '{}'::jsonb)
     RETURNING id`,
    [userAId]
  );
  const requestAId = request.rows[0].id;

  const itinerary = await db.query<{ id: string }>(
    `INSERT INTO public.itineraries
       (request_id, option_index, stops, valid, prompt_versions, models)
     VALUES ($1, 0, '[{"place_id":"abc","name":"Cafe"}]'::jsonb, true, '{}'::jsonb, '{}'::jsonb)
     RETURNING id`,
    [requestAId]
  );
  const itineraryAId = itinerary.rows[0].id;

  const invalid = await db.query<{ id: string }>(
    `INSERT INTO public.itineraries
       (request_id, option_index, stops, valid, prompt_versions, models)
     VALUES ($1, 1, '[{"place_id":"def"}]'::jsonb, false, '{}'::jsonb, '{}'::jsonb)
     RETURNING id`,
    [requestAId]
  );

  const saved = await asRole(db, "service_role", null, async () =>
    db.query<{ id: string; share_slug: string }>(
      `SELECT * FROM public.save_plan($1, $2)`,
      [userAId, itineraryAId]
    )
  );

  return {
    userAId,
    userBId,
    requestAId,
    itineraryAId,
    itineraryInvalidId: invalid.rows[0].id,
    slug: saved.rows[0].share_slug,
  };
}

/**
 * Behavioral oracle used both as regular tests and as the mutation catcher.
 * Each listed break must make at least one of these assertions fail.
 */
export async function assertInvariants(db: PGlite): Promise<void> {
  const data = await seed(db);

  await assertOptionIndexBounds(db, data.requestAId);
  await assertCoordsTtlAndPairing(db);
  await assertCleanupBehavior(db);
  await assertCleanupPrivileges(db);
  await assertSlugExactMatch(db, data.slug);
  await assertPoliciesAndGrants(db, data);
  await assertShareRpc(db, data);
  await assertSaveRpc(db, data);
  await assertFetchedAtGuards(db);
  await assertNullableCostLatency(db);
  await assertNoPayloadColumn(db);
  await assertRequestDeleteRestricted(db, data);
}

async function assertOptionIndexBounds(db: PGlite, requestId: string): Promise<void> {
  await db.query(
    `INSERT INTO public.itineraries
       (request_id, option_index, stops, prompt_versions, models)
     VALUES ($1, 2, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb)`,
    [requestId]
  );
  await expectRejects(
    () =>
      db.query(
        `INSERT INTO public.itineraries
           (request_id, option_index, stops, prompt_versions, models)
         VALUES ($1, 3, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb)`,
        [requestId]
      ),
    /check constraint|option_index/i
  );
  await expectRejects(
    () =>
      db.query(
        `INSERT INTO public.itineraries
           (request_id, option_index, stops, prompt_versions, models)
         VALUES ($1, -1, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb)`,
        [requestId]
      ),
    /check constraint|option_index/i
  );
}

async function assertCoordsTtlAndPairing(db: PGlite): Promise<void> {
  await expectRejects(
    () =>
      db.query(
        `INSERT INTO public.places_cache
           (place_id, lat, lng, coords_fetched_at, coords_expires_at)
         VALUES ('ttl31', 40.7, -74.0, NOW(), NOW() + INTERVAL '31 days')`
      ),
    /check constraint|coords/i
  );
  await expectRejects(
    () =>
      db.query(
        `INSERT INTO public.places_cache
           (place_id, lat, lng, coords_fetched_at, coords_expires_at)
         VALUES ('ttl365', 40.7, -74.0, NOW(), NOW() + INTERVAL '365 days')`
      ),
    /check constraint|coords/i
  );
  await expectRejects(
    () =>
      db.query(
        `INSERT INTO public.places_cache (place_id, lat, lng)
         VALUES ('pair', 40.7, NULL)`
      ),
    /check constraint|coords/i
  );
}

async function assertCleanupBehavior(db: PGlite): Promise<void> {
  await db.query(
    `INSERT INTO public.places_cache
       (place_id, lat, lng, coords_fetched_at, coords_expires_at)
     VALUES
       ('expired', 1, 2, NOW() - INTERVAL '20 days', NOW() - INTERVAL '10 days'),
       ('fresh', 3, 4, NOW(), NOW() + INTERVAL '10 days')`
  );

  const prosecdef = await db.query<{ prosecdef: boolean }>(`
    SELECT prosecdef FROM pg_proc
    WHERE proname = 'cleanup_expired_cache'
  `);
  assert.equal(prosecdef.rows[0]?.prosecdef, true);

  const cleaned = await asRole(db, "service_role", null, async () =>
    db.query<{ cleanup_expired_cache: number }>(`SELECT public.cleanup_expired_cache()`)
  );
  assert.ok(Number(cleaned.rows[0].cleanup_expired_cache) >= 1);

  const expired = await db.query<{ lat: number | null }>(
    `SELECT lat FROM public.places_cache WHERE place_id = 'expired'`
  );
  assert.equal(expired.rows.length, 1, "cleanup must keep place_id rows");
  assert.equal(expired.rows[0].lat, null);

  const fresh = await db.query<{ lat: string | number | null }>(
    `SELECT lat FROM public.places_cache WHERE place_id = 'fresh'`
  );
  assert.equal(fresh.rows.length, 1);
  assert.notEqual(fresh.rows[0].lat, null);
}

async function assertCleanupPrivileges(db: PGlite): Promise<void> {
  await asRole(db, "authenticated", null, async () => {
    await expectPermissionDenied(() => db.query(`SELECT public.cleanup_expired_cache()`));
  });
  await asRole(db, "anon", null, async () => {
    await expectPermissionDenied(() => db.query(`SELECT public.cleanup_expired_cache()`));
  });
}

async function assertSlugExactMatch(db: PGlite, slug: string): Promise<void> {
  await asRole(db, "anon", null, async () => {
    const wildcard = await db.query(`SELECT * FROM public.get_shared_plan($1)`, [`${slug}%`]);
    assert.equal(wildcard.rows.length, 0, "slug match must be exact, not LIKE");
    const found = await db.query(`SELECT * FROM public.get_shared_plan($1)`, [slug]);
    assert.equal(found.rows.length, 1);
  });
}

async function assertPoliciesAndGrants(db: PGlite, data: Seed): Promise<void> {
  await asRole(db, "authenticated", data.userBId, async () => {
    await expectPermissionDenied(() =>
      db.query(
        `INSERT INTO public.saved_plans (user_id, itinerary_id, share_slug)
         VALUES ($1, $2, 'clientchosenslug1')`,
        [data.userAId, data.itineraryAId]
      )
    );
    await expectPermissionDenied(() =>
      db.query(
        `INSERT INTO public.saved_plans (user_id, itinerary_id, share_slug)
         VALUES ($1, $2, 'clientchosenslug2')`,
        [data.userBId, data.itineraryAId]
      )
    );
    const deleted = await db.query(
      `DELETE FROM public.saved_plans WHERE itinerary_id = $1 RETURNING id`,
      [data.itineraryAId]
    );
    assert.equal(deleted.rows.length, 0);
    await expectPermissionDenied(() => db.query(`TRUNCATE public.saved_plans`));
    await expectPermissionDenied(() => db.query(`SELECT * FROM public.requests`));
    await expectPermissionDenied(() => db.query(`SELECT * FROM public.itineraries`));
  });

  await asRole(db, "anon", null, async () => {
    await expectPermissionDenied(() => db.query(`SELECT * FROM public.requests`));
    await expectPermissionDenied(() => db.query(`SELECT * FROM public.itineraries`));
    await expectPermissionDenied(() => db.query(`SELECT * FROM public.saved_plans`));
    await expectPermissionDenied(() =>
      db.query(`INSERT INTO public.feedback (itinerary_id, thumbs) VALUES ($1, 1)`, [
        data.itineraryAId,
      ])
    );
  });

  const remaining = await db.query(
    `SELECT id FROM public.saved_plans WHERE itinerary_id = $1`,
    [data.itineraryAId]
  );
  assert.equal(remaining.rows.length, 1);

  const policies = await db.query<{ cmd: string; qual: string | null; with_check: string | null }>(`
    SELECT cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'saved_plans'
  `);
  assert.equal(
    policies.rows.some((row) => row.cmd === "INSERT"),
    false,
    "saved_plans must not have an INSERT policy"
  );
  for (const policy of policies.rows) {
    assert.notEqual((policy.qual ?? "").trim(), "true", `${policy.cmd} policy must not be USING (true)`);
    assert.notEqual((policy.with_check ?? "").trim(), "true", `${policy.cmd} policy must not be WITH CHECK (true)`);
  }
}

async function assertShareRpc(db: PGlite, data: Seed): Promise<void> {
  const invalidSave = await asRole(db, "service_role", null, async () =>
    db.query<{ share_slug: string }>(`SELECT * FROM public.save_plan($1, $2)`, [
      data.userAId,
      data.itineraryInvalidId,
    ])
  );
  const invalidSlug = invalidSave.rows[0].share_slug;

  await asRole(db, "anon", null, async () => {
    const invalid = await db.query(`SELECT * FROM public.get_shared_plan($1)`, [
      invalidSlug,
    ]);
    assert.equal(invalid.rows.length, 0, "share RPC must hide invalid itineraries");

    const valid = await db.query<Record<string, unknown>>(`SELECT * FROM public.get_shared_plan($1)`, [
      data.slug,
    ]);
    assert.equal(valid.rows.length, 1);
    const columns = Object.keys(valid.rows[0]);
    assert.ok(!columns.includes("user_id"));
    assert.ok(!columns.includes("redacted_text"));
    assert.ok(!columns.includes("client_hash"));
    assert.equal(valid.rows[0].valid, true);
  });
}

async function assertSaveRpc(db: PGlite, data: Seed): Promise<void> {
  await asRole(db, "authenticated", data.userBId, async () => {
    await expectPermissionDenied(() =>
      db.query(`SELECT * FROM public.save_plan($1, $2)`, [data.userBId, data.itineraryAId])
    );
  });

  await asRole(db, "service_role", null, async () => {
    await expectRejects(
      () => db.query(`SELECT * FROM public.save_plan($1, $2)`, [data.userBId, data.itineraryAId]),
      /another user's itinerary|cannot save/i
    );
  });

  const args = await db.query<{ pronargs: number }>(`
    SELECT p.pronargs
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'save_plan'
  `);
  assert.equal(args.rows[0].pronargs, 2, "save_plan must not take a client-chosen slug");
}

async function assertFetchedAtGuards(db: PGlite): Promise<void> {
  await expectRejects(
    () =>
      db.query(
        `INSERT INTO public.places_cache
           (place_id, lat, lng, coords_fetched_at, coords_expires_at)
         VALUES ('future', 1, 2, NOW() + INTERVAL '1 hour', NOW() + INTERVAL '2 days')`
      ),
    /check constraint|future|coords_fetched/i
  );

  await db.query(
    `INSERT INTO public.places_cache
       (place_id, lat, lng, coords_fetched_at, coords_expires_at)
     VALUES ('bump', 1, 2, NOW(), NOW() + INTERVAL '2 days')`
  );
  await expectRejects(
    () =>
      db.query(
        `UPDATE public.places_cache
         SET coords_fetched_at = coords_fetched_at + INTERVAL '1 second'
         WHERE place_id = 'bump'`
      ),
    /cannot change unless lat\/lng/i
  );
}

async function assertNullableCostLatency(db: PGlite): Promise<void> {
  const request = await db.query<{ id: string }>(
    `INSERT INTO public.requests (redacted_text, parsed_intent)
     VALUES ('cost row', '{}'::jsonb)
     RETURNING id`
  );
  const row = await db.query<{ cost_usd: unknown; latency_ms: unknown }>(
    `INSERT INTO public.itineraries
       (request_id, option_index, stops, prompt_versions, models)
     VALUES ($1, 0, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb)
     RETURNING cost_usd, latency_ms`,
    [request.rows[0].id]
  );
  assert.equal(row.rows[0].cost_usd, null);
  assert.equal(row.rows[0].latency_ms, null);
}

async function assertNoPayloadColumn(db: PGlite): Promise<void> {
  const columns = await db.query<{ column_name: string }>(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'places_cache'
  `);
  const names = new Set(columns.rows.map((row) => row.column_name));
  assert.equal(names.has("payload"), false);
}

async function assertRequestDeleteRestricted(db: PGlite, data: Seed): Promise<void> {
  await expectRejects(
    () => db.query(`DELETE FROM public.requests WHERE id = $1`, [data.requestAId]),
    /foreign key|still referenced|restrict/i
  );
  const plan = await db.query(
    `SELECT id FROM public.saved_plans WHERE itinerary_id = $1`,
    [data.itineraryAId]
  );
  assert.equal(plan.rows.length, 1);
}
