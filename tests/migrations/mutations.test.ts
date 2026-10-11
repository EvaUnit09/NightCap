import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MIGRATION_SQL, createMigratedDatabase } from "./harness";
import { assertInvariants } from "./invariants";

type Mutation = {
  name: string;
  apply: (sql: string) => string;
};

const MUTATIONS: Mutation[] = [
  {
    name: "ttl raised to 31 days",
    apply: (sql) => sql.replace("INTERVAL '30 days'", "INTERVAL '31 days'"),
  },
  {
    name: "ttl raised to 365 days",
    apply: (sql) => sql.replace("INTERVAL '30 days'", "INTERVAL '365 days'"),
  },
  {
    name: "ttl check dropped",
    apply: (sql) =>
      sql.replace(
        /CONSTRAINT places_cache_coords_ttl CHECK \([\s\S]*?\),/,
        ""
      ),
  },
  {
    name: "cleanup deletes rows",
    apply: (sql) =>
      sql.replace(
        /UPDATE public\.places_cache[\s\S]*?coords_expires_at < NOW\(\);/,
        `DELETE FROM public.places_cache
  WHERE coords_expires_at IS NOT NULL
    AND coords_expires_at < NOW();`
      ),
  },
  {
    name: "cleanup nulls fresh coords",
    apply: (sql) =>
      sql.replace(
        "WHERE coords_expires_at IS NOT NULL\n    AND coords_expires_at < NOW();",
        "WHERE coords_expires_at IS NOT NULL;"
      ),
  },
  {
    name: "cleanup missing SECURITY DEFINER",
    apply: (sql) =>
      sql.replace(
        /CREATE OR REPLACE FUNCTION public\.cleanup_expired_cache\(\)\nRETURNS INTEGER\nLANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = ''/,
        `CREATE OR REPLACE FUNCTION public.cleanup_expired_cache()
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = ''`
      ),
  },
  {
    name: "cleanup REVOKE removed from authenticated",
    apply: (sql) =>
      sql.replace(
        "REVOKE ALL ON FUNCTION public.cleanup_expired_cache() FROM authenticated;\n",
        ""
      ),
  },
  {
    name: "LIKE used for slug matching",
    apply: (sql) =>
      sql.replace(
        "WHERE sp.share_slug = get_shared_plan.slug",
        "WHERE sp.share_slug LIKE get_shared_plan.slug"
      ),
  },
  {
    name: "insert policy set to true",
    apply: (sql) =>
      sql +
      `
CREATE POLICY saved_plans_insert_any ON public.saved_plans
  FOR INSERT TO authenticated
  WITH CHECK (true);
GRANT INSERT ON TABLE public.saved_plans TO authenticated;
`,
  },
  {
    name: "delete policy set to true",
    apply: (sql) =>
      sql.replace(
        `CREATE POLICY saved_plans_delete_own ON public.saved_plans
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);`,
        `CREATE POLICY saved_plans_delete_any ON public.saved_plans
  FOR DELETE TO authenticated
  USING (true);`
      ),
  },
  {
    name: "option_index widened to 0-20",
    apply: (sql) =>
      sql.replace(
        "CONSTRAINT itineraries_option_index_range CHECK (option_index BETWEEN 0 AND 2)",
        "CONSTRAINT itineraries_option_index_range CHECK (option_index BETWEEN 0 AND 20)"
      ),
  },
  {
    name: "lat/lng pairing CHECK dropped",
    apply: (sql) =>
      sql.replace(
        /CONSTRAINT places_cache_coords_pair CHECK \([\s\S]*?\),/,
        ""
      ),
  },
  {
    name: "GRANT ALL to authenticated",
    apply: (sql) =>
      sql.replace(
        "GRANT SELECT, DELETE ON TABLE public.saved_plans TO authenticated;",
        "GRANT ALL ON TABLE public.saved_plans TO authenticated;"
      ),
  },
  {
    name: "anon SELECT on requests",
    apply: (sql) =>
      sql +
      `
CREATE POLICY requests_public ON public.requests FOR SELECT TO anon USING (true);
GRANT SELECT ON TABLE public.requests TO anon;
`,
  },
  {
    name: "anon SELECT on itineraries",
    apply: (sql) =>
      sql +
      `
CREATE POLICY itineraries_public ON public.itineraries FOR SELECT TO anon USING (true);
GRANT SELECT ON TABLE public.itineraries TO anon;
`,
  },
  {
    name: "anon INSERT on feedback",
    apply: (sql) =>
      sql +
      `
CREATE POLICY feedback_insert_any ON public.feedback FOR INSERT TO anon WITH CHECK (true);
GRANT INSERT ON TABLE public.feedback TO anon;
`,
  },
  {
    name: "RESTRICT replaced with CASCADE",
    apply: (sql) =>
      sql.replace(
        "REFERENCES public.itineraries (id) ON DELETE RESTRICT",
        "REFERENCES public.itineraries (id) ON DELETE CASCADE"
      ),
  },
  {
    name: "slug CHECK shortened to 6 chars",
    apply: (sql) =>
      sql.replace(
        "CONSTRAINT saved_plans_share_slug_format CHECK (share_slug ~ '^[A-Za-z0-9_-]{16,64}$')",
        "CONSTRAINT saved_plans_share_slug_format CHECK (share_slug ~ '^[A-Za-z0-9_-]{6,64}$')"
      ),
  },
  {
    name: "get_shared_plan missing SECURITY DEFINER",
    apply: (sql) =>
      sql.replace(
        /CREATE OR REPLACE FUNCTION public\.get_shared_plan\(slug text\)\nRETURNS TABLE \([\s\S]*?\)\nLANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = ''/,
        (match) => match.replace("\nSECURITY DEFINER", "")
      ),
  },
  {
    name: "get_shared_plan returns invalid itineraries",
    apply: (sql) => sql.replace("\n    AND i.valid = true", ""),
  },
  {
    name: "payload column added",
    apply: (sql) =>
      sql.replace(
        "  coords_expires_at TIMESTAMPTZ,",
        "  coords_expires_at TIMESTAMPTZ,\n  payload JSONB,"
      ),
  },
  {
    name: "save_plan executable by authenticated",
    apply: (sql) =>
      sql.replace(
        "GRANT EXECUTE ON FUNCTION public.save_plan(uuid, uuid) TO service_role;",
        `GRANT EXECUTE ON FUNCTION public.save_plan(uuid, uuid) TO service_role, authenticated;`
      ),
  },
  {
    name: "save_plan skips owner check",
    apply: (sql) =>
      sql.replace(
        "request_owner IS DISTINCT FROM p_user_id",
        "FALSE"
      ),
  },
  {
    name: "future coords_fetched_at allowed",
    apply: (sql) =>
      sql.replace(
        /CONSTRAINT places_cache_coords_fetched_not_future CHECK \([\s\S]*?\)\n/,
        ""
      ),
  },
  {
    name: "fetched_at bump trigger dropped",
    apply: (sql) =>
      sql.replace(
        /CREATE TRIGGER places_cache_guard_fetched_at[\s\S]*?EXECUTE FUNCTION public\.places_cache_guard_fetched_at\(\);\n/,
        ""
      ),
  },
  {
    name: "cleanup EXECUTE granted to authenticated",
    apply: (sql) =>
      sql.replace(
        "GRANT EXECUTE ON FUNCTION public.cleanup_expired_cache() TO service_role;",
        "GRANT EXECUTE ON FUNCTION public.cleanup_expired_cache() TO service_role, authenticated;"
      ),
  },
  {
    name: "option_index check dropped",
    apply: (sql) =>
      sql.replace(
        "CONSTRAINT itineraries_option_index_range CHECK (option_index BETWEEN 0 AND 2),\n  ",
        ""
      ),
  },
  {
    name: "cost_usd default 0 restored",
    apply: (sql) =>
      sql.replace("  cost_usd DECIMAL(10, 6),\n", "  cost_usd DECIMAL(10, 6) NOT NULL DEFAULT 0,\n"),
  },
  {
    name: "get_shared_plan returns user_id",
    apply: (sql) =>
      sql
        .replace(
          `RETURNS TABLE (
  itinerary_id uuid,
  option_index integer,
  stops jsonb,
  valid boolean,
  created_at timestamptz
)`,
          `RETURNS TABLE (
  itinerary_id uuid,
  option_index integer,
  stops jsonb,
  valid boolean,
  created_at timestamptz,
  user_id uuid
)`
        )
        .replace(
          "    i.created_at\n  FROM public.saved_plans AS sp",
          "    i.created_at,\n    sp.user_id\n  FROM public.saved_plans AS sp"
        ),
  },
  {
    name: "authenticated TRUNCATE via ALL on all tables",
    apply: (sql) =>
      sql +
      `
GRANT ALL ON TABLE public.requests TO authenticated;
GRANT ALL ON TABLE public.itineraries TO authenticated;
GRANT ALL ON TABLE public.saved_plans TO authenticated;
`,
  },
  {
    name: "share slug matched with LIKE prefix always",
    apply: (sql) =>
      sql.replace(
        "WHERE sp.share_slug = get_shared_plan.slug",
        "WHERE sp.share_slug LIKE get_shared_plan.slug || '%'"
      ),
  },
  {
    name: "REVOKE authenticated omitted on saved_plans",
    apply: (sql) =>
      sql.replace(
        "REVOKE ALL ON TABLE public.saved_plans FROM PUBLIC, anon, authenticated;",
        "REVOKE ALL ON TABLE public.saved_plans FROM PUBLIC, anon;"
      ),
  },
  {
    name: "stops placeId-only CHECK dropped",
    apply: (sql) =>
      sql.replace(
        "  CONSTRAINT itineraries_stops_place_ids_only CHECK (public.itineraries_stops_are_place_ids_only(stops)),\n",
        ""
      ),
  },
];

assert.equal(MUTATIONS.length, 33, "mutation suite must list 33 breaks");

describe("migration mutation suite", { concurrency: 1 }, () => {
  it("unmutated migration satisfies the oracle", async () => {
    const db = await createMigratedDatabase();
    try {
      await assertInvariants(db);
    } finally {
      await db.close();
    }
  });

  it("catches all 33 listed breaks", async () => {
    const missed: string[] = [];

    for (const mutation of MUTATIONS) {
      const sql = mutation.apply(MIGRATION_SQL);
      assert.notEqual(sql, MIGRATION_SQL, `mutation ${mutation.name} did not change SQL`);

      let caught = false;
      try {
        const db = await createMigratedDatabase(sql);
        try {
          await assertInvariants(db);
        } catch {
          caught = true;
        } finally {
          await db.close();
        }
      } catch {
        caught = true;
      }

      if (!caught) {
        missed.push(mutation.name);
      }
    }

    assert.equal(
      missed.length,
      0,
      `caught ${33 - missed.length}/33 mutations; missed: ${missed.join("; ")}`
    );
  });
});
