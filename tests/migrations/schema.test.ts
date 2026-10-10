import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { PGlite } from "@electric-sql/pglite";

import { asRole, createMigratedDatabase, expectPermissionDenied, expectRejects } from "./harness";
import { assertInvariants } from "./invariants";

describe("Supabase migration with real Postgres", { concurrency: 1 }, () => {
  let db: PGlite;

  before(async () => {
    db = await createMigratedDatabase();
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.exec(`
      TRUNCATE TABLE
        public.feedback,
        public.saved_plans,
        public.itineraries,
        public.requests,
        public.places_cache
      RESTART IDENTITY CASCADE;
      DELETE FROM auth.users;
    `);
  });

  describe("catalog", () => {
    it("creates the five tables and enables RLS on each", async () => {
      const tables = await db.query<{ relname: string; relrowsecurity: boolean }>(`
        SELECT c.relname, c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname IN ('requests', 'itineraries', 'feedback', 'places_cache', 'saved_plans')
        ORDER BY c.relname
      `);
      assert.deepEqual(
        tables.rows.map((row) => row.relname),
        ["feedback", "itineraries", "places_cache", "requests", "saved_plans"]
      );
      for (const row of tables.rows) {
        assert.equal(row.relrowsecurity, true, `${row.relname} must have RLS enabled`);
      }
    });

    it("has no public policies on requests, itineraries, feedback, or places_cache", async () => {
      const policies = await db.query(`
        SELECT tablename, policyname
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename IN ('requests', 'itineraries', 'feedback', 'places_cache')
      `);
      assert.deepEqual(policies.rows, []);
    });

    it("has no INSERT policy on saved_plans", async () => {
      const policies = await db.query<{ cmd: string; qual: string | null; with_check: string | null }>(`
        SELECT cmd, qual, with_check
        FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'saved_plans'
      `);
      assert.ok(policies.rows.every((row) => row.cmd !== "INSERT"));
      for (const policy of policies.rows) {
        assert.ok(!/true/i.test(policy.qual ?? ""));
        assert.ok(!/true/i.test(policy.with_check ?? ""));
      }
    });

    it("defines get_shared_plan as SECURITY DEFINER with empty search_path", async () => {
      const fn = await db.query<{ prosecdef: boolean; proconfig: string[] | null }>(`
        SELECT p.prosecdef, p.proconfig
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'get_shared_plan'
      `);
      assert.equal(fn.rows[0].prosecdef, true);
      assert.ok((fn.rows[0].proconfig ?? []).some((entry) => /search_path\s*=\s*['"]{2}/.test(entry)));
    });

    it("restricts deleting an itinerary referenced by saved_plans", async () => {
      const fk = await db.query<{ confdeltype: string }>(`
        SELECT confdeltype
        FROM pg_constraint
        WHERE contype = 'f'
          AND conrelid = 'public.saved_plans'::regclass
          AND confrelid = 'public.itineraries'::regclass
      `);
      assert.equal(fk.rows[0].confdeltype, "r");
    });

    it("stores exactly the terms-permitted places_cache columns", async () => {
      const columns = await db.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'places_cache'
        ORDER BY column_name
      `);
      assert.deepEqual(
        columns.rows.map((row) => row.column_name),
        ["coords_expires_at", "coords_fetched_at", "lat", "lng", "place_id"]
      );
    });

    it("rejects disallowed Places details columns on places_cache", async () => {
      const columns = await db.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'places_cache'
      `);
      const names = new Set(columns.rows.map((row) => row.column_name));
      for (const column of [
        "payload",
        "name",
        "hours",
        "opening_hours",
        "price",
        "price_level",
        "rating",
      ]) {
        assert.equal(names.has(column), false, `disallowed column ${column}`);
      }
    });

    it("stores heuristically redacted text on requests.redacted_text", async () => {
      const columns = await db.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'requests' AND column_name = 'redacted_text'
      `);
      assert.equal(columns.rows.length, 1);
    });
  });

  describe("behavioral invariants under Supabase roles", () => {
    it("holds the mutation-oracle invariants", async () => {
      await assertInvariants(db);
    });

    it("rejects option_index outside 0..2 on real inserts", async () => {
      const request = await db.query<{ id: string }>(
        `INSERT INTO public.requests (redacted_text, parsed_intent)
         VALUES ('bounds', '{}'::jsonb) RETURNING id`
      );
      const id = request.rows[0].id;
      for (const index of [0, 1, 2]) {
        await db.query(
          `INSERT INTO public.itineraries
             (request_id, option_index, stops, prompt_versions, models)
           VALUES ($1, $2, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb)`,
          [id, index]
        );
      }
      await expectRejects(
        () =>
          db.query(
            `INSERT INTO public.itineraries
               (request_id, option_index, stops, prompt_versions, models)
             VALUES ($1, 3, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb)`,
            [id]
          ),
        /check constraint|option_index/i
      );
    });

    it("hides expired coordinates through places_cache_live", async () => {
      await db.query(
        `INSERT INTO public.places_cache
           (place_id, lat, lng, coords_fetched_at, coords_expires_at)
         VALUES ('live-expired', 1, 2, NOW() - INTERVAL '20 days', NOW() - INTERVAL '1 day')`
      );
      const live = await db.query<{ lat: unknown }>(
        `SELECT lat FROM public.places_cache_live WHERE place_id = 'live-expired'`
      );
      assert.equal(live.rows[0].lat, null);
    });

    it("lets authenticator assume authenticated and still cannot TRUNCATE", async () => {
      await asRole(db, "authenticator", null, async () => {
        await db.exec("SET ROLE authenticated");
        await expectPermissionDenied(() => db.query("TRUNCATE public.saved_plans"));
      });
    });

    it("blocks deleting a request that still has a saved plan", async () => {
      const user = await db.query<{ id: string }>(
        `INSERT INTO auth.users (email) VALUES ('restrict@test.com') RETURNING id`
      );
      const request = await db.query<{ id: string }>(
        `INSERT INTO public.requests (user_id, redacted_text, parsed_intent)
         VALUES ($1, 'kept', '{}'::jsonb) RETURNING id`,
        [user.rows[0].id]
      );
      const itinerary = await db.query<{ id: string }>(
        `INSERT INTO public.itineraries
           (request_id, option_index, stops, valid, prompt_versions, models)
         VALUES ($1, 0, '[]'::jsonb, true, '{}'::jsonb, '{}'::jsonb) RETURNING id`,
        [request.rows[0].id]
      );
      await asRole(db, "service_role", null, async () => {
        await db.query(`SELECT * FROM public.save_plan($1, $2)`, [
          user.rows[0].id,
          itinerary.rows[0].id,
        ]);
      });
      await expectRejects(
        () => db.query(`DELETE FROM public.requests WHERE id = $1`, [request.rows[0].id]),
        /foreign key|still referenced|restrict/i
      );
    });
  });
});
