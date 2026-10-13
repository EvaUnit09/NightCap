import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

export const MIGRATION_PATH = join(
  process.cwd(),
  "supabase/migrations/20261010170501_init.sql"
);

export const MIGRATION_SQL = readFileSync(MIGRATION_PATH, "utf-8");

/**
 * Minimal Supabase-like roles and default grants.
 * authenticator is the login role; anon/authenticated/service_role are SET ROLE targets.
 * Default privileges match hosted Supabase (ALL on new tables/functions to those roles)
 * so the migration's REVOKEs are what actually lock things down.
 */
export const SHIM_SQL = `
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
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
      CREATE ROLE authenticator NOINHERIT LOGIN;
    END IF;
  END $$;

  GRANT anon TO authenticator;
  GRANT authenticated TO authenticator;
  GRANT service_role TO authenticator;

  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, authenticator;
  GRANT ALL ON SCHEMA public TO service_role;

  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

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

  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role, authenticator;
  GRANT SELECT ON auth.users TO anon, authenticated, service_role;
  GRANT INSERT, UPDATE, DELETE ON auth.users TO service_role;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role, authenticator;
`;

export type RoleName = "anon" | "authenticated" | "service_role" | "authenticator";

export function migrationPaths(): string[] {
  const dir = join(process.cwd(), "supabase/migrations");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => join(dir, name));
}

export async function createMigratedDatabase(sql?: string): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SHIM_SQL);
  const scripts = sql === undefined ? migrationPaths().map((path) => readFileSync(path, "utf-8")) : [sql];
  for (const script of scripts) {
    await db.exec(script);
  }
  await db.exec(`
    GRANT SELECT, INSERT, UPDATE, DELETE ON auth.users TO service_role;
  `);
  return db;
}

export async function asRole<T>(
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

export async function expectPermissionDenied(fn: () => Promise<unknown>): Promise<void> {
  const { default: assert } = await import("node:assert/strict");
  await assert.rejects(fn, (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    return /permission denied/i.test(message);
  });
}

export async function expectRejects(
  fn: () => Promise<unknown>,
  pattern: RegExp
): Promise<void> {
  const { default: assert } = await import("node:assert/strict");
  await assert.rejects(fn, (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    return pattern.test(message);
  });
}
