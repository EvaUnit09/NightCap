import "server-only";

import postgres from "postgres";

import type { Queryable } from "../monitoring/store-request";

type Runner = {
  unsafe(query: string, parameters?: unknown[]): Promise<Iterable<Record<string, unknown>>>;
  begin<T>(cb: (sql: Runner) => T | Promise<T>): Promise<T>;
};

function asQueryable(sql: Runner, nested = false): Queryable {
  const queryable: Queryable = {
    async query<T>(text: string, params: unknown[] = []) {
      const rows = await sql.unsafe(text, params);
      return { rows: [...rows] as T[] };
    },
  };
  if (!nested) {
    (queryable as Queryable & { transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> }).transaction = (fn) =>
      sql.begin((tx) => fn(asQueryable(tx, true)));
  }
  return queryable;
}

export function createPostgresQueryable(url: string): Queryable {
  const sql = postgres(url, {
    max: 4,
    prepare: false,
    idle_timeout: 20,
    onnotice: () => {},
  });
  return asQueryable(sql as unknown as Runner);
}

let singleton: { url: string; db: Queryable } | null = null;

export function databaseUrl(env: Record<string, string | undefined>): string | undefined {
  const url = env.DATABASE_URL?.trim() || env.SUPABASE_DB_URL?.trim();
  return url ? url : undefined;
}

/** One pool per process when the URL is the live environment. No URL means no database. */
export function createQueryableFromEnv(env: Record<string, string | undefined> = process.env): Queryable | null {
  const url = databaseUrl(env);
  if (!url) return null;
  if (env === process.env && singleton?.url === url) return singleton.db;
  const db = createPostgresQueryable(url);
  if (env === process.env) singleton = { url, db };
  return db;
}
