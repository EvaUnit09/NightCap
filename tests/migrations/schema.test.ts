import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION_PATH = join(process.cwd(), "supabase/migrations/20261010170501_init.sql");
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, "utf-8");

const SHIM_SQL = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      CREATE ROLE anon NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      CREATE ROLE authenticated NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
    END IF;
  END $$;

  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  GRANT ALL ON SCHEMA public TO service_role;

  CREATE SCHEMA IF NOT EXISTS auth;

  CREATE TABLE IF NOT EXISTS auth.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE OR REPLACE FUNCTION auth.uid()
  RETURNS UUID
  LANGUAGE sql
  STABLE
  AS $$
    SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
  $$;

  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  GRANT SELECT ON auth.users TO anon, authenticated, service_role;
  GRANT INSERT, UPDATE, DELETE ON auth.users TO service_role;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
`;

type RoleName = "anon" | "authenticated" | "service_role";

async function asRole<T>(
  db: PGlite,
  role: RoleName,
  uid: string | null,
  fn: () => Promise<T>
): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  if (uid) {
    await db.exec(`SET request.jwt.claim.sub = '${uid}'`);
  } else {
    await db.exec(`SET request.jwt.claim.sub = ''`);
  }
  try {
    return await fn();
  } finally {
    await db.exec("RESET ROLE");
    await db.exec("RESET request.jwt.claim.sub");
  }
}

async function expectPermissionDenied(fn: () => Promise<unknown>): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    return /permission denied/i.test(message);
  });
}

describe("Supabase migration with real Postgres", { concurrency: 1 }, () => {
  let db: PGlite;

  before(async () => {
    db = new PGlite();
    await db.exec(SHIM_SQL);
    await db.exec(MIGRATION_SQL);
    await db.exec(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON auth.users TO service_role;
    `);
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

    it("has no public SELECT policies on requests, itineraries, or feedback", async () => {
      const policies = await db.query<{ tablename: string; policyname: string }>(`
        SELECT tablename, policyname
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename IN ('requests', 'itineraries', 'feedback', 'places_cache')
      `);
      assert.deepEqual(policies.rows, []);
    });

    it("has only owner policies on saved_plans (no share-slug IS NOT NULL policy)", async () => {
      const policies = await db.query<{ policyname: string; qual: string | null }>(`
        SELECT policyname, qual
        FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'saved_plans'
      `);
      assert.ok(policies.rows.length >= 3);
      for (const policy of policies.rows) {
        assert.ok(
          !/share_slug\s+IS\s+NOT\s+NULL/i.test(policy.qual ?? ""),
          `policy ${policy.policyname} must not use share_slug IS NOT NULL`
        );
      }
    });

    it("defines get_shared_plan as SECURITY DEFINER with empty search_path", async () => {
      const fn = await db.query<{ prosecdef: boolean; proconfig: string[] | null }>(`
        SELECT p.prosecdef, p.proconfig
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'get_shared_plan'
      `);
      assert.equal(fn.rows.length, 1);
      assert.equal(fn.rows[0].prosecdef, true);
      assert.ok(
        (fn.rows[0].proconfig ?? []).some((entry) =>
          /search_path\s*=\s*['"]{2}/.test(entry)
        ),
        "get_shared_plan must SET search_path = ''"
      );
    });

    it("defines cleanup_expired_cache with empty search_path and no execute for anon", async () => {
      const fn = await db.query<{ prosecdef: boolean; proconfig: string[] | null }>(`
        SELECT p.prosecdef, p.proconfig
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'cleanup_expired_cache'
      `);
      assert.equal(fn.rows.length, 1);
      assert.ok(
        (fn.rows[0].proconfig ?? []).some((entry) =>
          /search_path\s*=\s*['"]{2}/.test(entry)
        ),
        "cleanup_expired_cache must SET search_path = ''"
      );

      const grants = await db.query<{ grantee: string }>(`
        SELECT grantee
        FROM information_schema.routine_privileges
        WHERE routine_schema = 'public'
          AND routine_name = 'cleanup_expired_cache'
          AND privilege_type = 'EXECUTE'
          AND grantee IN ('PUBLIC', 'anon', 'authenticated')
      `);
      assert.deepEqual(grants.rows, []);
    });

    it("restricts deleting an itinerary that is referenced by saved_plans", async () => {
      const fk = await db.query<{ confdeltype: string }>(`
        SELECT confdeltype
        FROM pg_constraint
        WHERE contype = 'f'
          AND conrelid = 'public.saved_plans'::regclass
          AND confrelid = 'public.itineraries'::regclass
      `);
      assert.equal(fk.rows.length, 1);
      assert.equal(fk.rows[0].confdeltype, "r");
    });

    it("references auth.users from saved_plans.user_id with ON DELETE CASCADE", async () => {
      const fk = await db.query<{ confdeltype: string }>(`
        SELECT confdeltype
        FROM pg_constraint
        WHERE contype = 'f'
          AND conrelid = 'public.saved_plans'::regclass
          AND confrelid = 'auth.users'::regclass
      `);
      assert.equal(fk.rows.length, 1);
      assert.equal(fk.rows[0].confdeltype, "c");
    });

    it("checks option_index BETWEEN 0 AND 2", async () => {
      const check = await db.query<{ definition: string }>(`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE contype = 'c'
          AND conrelid = 'public.itineraries'::regclass
          AND conname LIKE '%option_index%'
      `);
      assert.equal(check.rows.length, 1);
      assert.match(check.rows[0].definition, /0/);
      assert.match(check.rows[0].definition, /2/);
    });

    it("checks share_slug is 16 to 64 URL-safe characters", async () => {
      const check = await db.query<{ definition: string }>(`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE contype = 'c'
          AND conrelid = 'public.saved_plans'::regclass
          AND conname LIKE '%slug%'
      `);
      assert.equal(check.rows.length, 1);
      assert.match(check.rows[0].definition, /16/);
      assert.match(check.rows[0].definition, /64/);
    });

    it("stores only terms-permitted places_cache columns (no payload)", async () => {
      const columns = await db.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'places_cache'
        ORDER BY ordinal_position
      `);
      const names = columns.rows.map((row) => row.column_name);
      assert.ok(names.includes("place_id"));
      assert.ok(names.includes("lat"));
      assert.ok(names.includes("lng"));
      assert.ok(names.includes("coords_expires_at"));
      assert.ok(!names.includes("payload"));
    });
  });

  describe("RLS behavior", () => {
    async function seedPlan(email: string, slug: string) {
      const user = await db.query<{ id: string }>(
        `INSERT INTO auth.users (email) VALUES ($1) RETURNING id`,
        [email]
      );
      const userId = user.rows[0].id;
      const request = await db.query<{ id: string }>(
        `INSERT INTO public.requests (redacted_text, parsed_intent)
         VALUES ('redacted date night', '{"area":"brooklyn"}'::jsonb)
         RETURNING id`
      );
      const itinerary = await db.query<{ id: string }>(
        `INSERT INTO public.itineraries
           (request_id, option_index, stops, valid, prompt_versions, models)
         VALUES ($1, 0, '[{"place_id":"abc"}]'::jsonb, true, '{}'::jsonb, '{}'::jsonb)
         RETURNING id`,
        [request.rows[0].id]
      );
      const plan = await db.query<{ id: string }>(
        `INSERT INTO public.saved_plans (user_id, itinerary_id, share_slug)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [userId, itinerary.rows[0].id, slug]
      );
      return {
        userId,
        requestId: request.rows[0].id,
        itineraryId: itinerary.rows[0].id,
        planId: plan.rows[0].id,
        slug,
      };
    }

    it("anon cannot read requests, itineraries, or saved_plans", async () => {
      await seedPlan("owner@test.com", "abcdefghijklmnop");
      await asRole(db, "anon", null, async () => {
        await expectPermissionDenied(() => db.query("SELECT * FROM public.requests"));
        await expectPermissionDenied(() => db.query("SELECT * FROM public.itineraries"));
        await expectPermissionDenied(() => db.query("SELECT * FROM public.saved_plans"));
      });
    });

    it("user A cannot read or modify user B's saved_plan", async () => {
      const planA = await seedPlan("usera@test.com", "useraplan1234567");
      const userB = await db.query<{ id: string }>(
        `INSERT INTO auth.users (email) VALUES ('userb@test.com') RETURNING id`
      );
      const userBId = userB.rows[0].id;

      await asRole(db, "authenticated", userBId, async () => {
        const visible = await db.query(
          `SELECT id FROM public.saved_plans WHERE id = $1`,
          [planA.planId]
        );
        assert.equal(visible.rows.length, 0);

        const deleted = await db.query(
          `DELETE FROM public.saved_plans WHERE id = $1 RETURNING id`,
          [planA.planId]
        );
        assert.equal(deleted.rows.length, 0);
      });

      const stillThere = await db.query(
        `SELECT id FROM public.saved_plans WHERE id = $1`,
        [planA.planId]
      );
      assert.equal(stillThere.rows.length, 1);
    });

    it("share RPC returns only safe fields for a valid slug and nothing for a bad one", async () => {
      const seeded = await seedPlan("sharer@test.com", "shareslug1234567");

      await asRole(db, "anon", null, async () => {
        const found = await db.query<Record<string, unknown>>(
          `SELECT * FROM public.get_shared_plan($1)`,
          [seeded.slug]
        );
        assert.equal(found.rows.length, 1);
        assert.equal(found.rows[0].itinerary_id, seeded.itineraryId);
        const columns = Object.keys(found.rows[0]);
        assert.deepEqual(
          columns.sort(),
          ["created_at", "itinerary_id", "option_index", "stops", "valid"].sort()
        );
        assert.ok(!columns.includes("user_id"));
        assert.ok(!columns.includes("redacted_text"));
        assert.ok(!columns.includes("client_hash"));

        const missing = await db.query(`SELECT * FROM public.get_shared_plan($1)`, [
          "does-not-exist-slug",
        ]);
        assert.equal(missing.rows.length, 0);
      });
    });

    it("anon cannot insert feedback", async () => {
      const seeded = await seedPlan("feedback@test.com", "feedbackslug1234");
      await asRole(db, "anon", null, async () => {
        await expectPermissionDenied(() =>
          db.query(
            `INSERT INTO public.feedback (itinerary_id, thumbs) VALUES ($1, 1)`,
            [seeded.itineraryId]
          )
        );
      });
    });

    it("anon cannot execute cleanup_expired_cache", async () => {
      await asRole(db, "anon", null, async () => {
        await expectPermissionDenied(() => db.query("SELECT public.cleanup_expired_cache()"));
      });
    });

    it("deleting a request does not remove a saved plan (RESTRICT)", async () => {
      const seeded = await seedPlan("restrict@test.com", "restrictslug12345");
      await assert.rejects(
        () => db.query(`DELETE FROM public.requests WHERE id = $1`, [seeded.requestId]),
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          return /foreign key|still referenced|restrict/i.test(message);
        }
      );
      const plan = await db.query(`SELECT id FROM public.saved_plans WHERE id = $1`, [
        seeded.planId,
      ]);
      assert.equal(plan.rows.length, 1);
    });
  });
});
