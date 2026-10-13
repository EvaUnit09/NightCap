import type { Queryable } from "../monitoring/store-request";

type Transactional = Queryable & {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
};

function withTransaction(db: Queryable): db is Transactional {
  return typeof (db as Transactional).transaction === "function";
}

export async function inTransaction<T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  if (withTransaction(db)) {
    return db.transaction(fn);
  }
  return fn(db);
}
