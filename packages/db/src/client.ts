import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
/** A transaction scoped to one tenant. All data access goes through this. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface Connection {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function connect(url: string, opts: { max?: number } = {}): Connection {
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 10 });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

export interface TenantScope {
  tenantId: string;
  /** Acting user. Exposed to the database (`app.user_id`) so triggers can enforce who may change guarded tables. */
  userId?: string;
  /** Enables the dev-login helper function for this transaction only. */
  allowDevLogin?: boolean;
}

/**
 * Runs `fn` in a transaction whose queries can only see/modify `tenantId`'s rows.
 * `set_config(..., true)` makes the setting transaction-local, so it cannot leak to another
 * request that reuses the pooled connection.
 */
export async function withTenant<T>(db: Db, scope: TenantScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${scope.tenantId}, true)`);
    if (scope.userId) await tx.execute(sql`select set_config('app.user_id', ${scope.userId}, true)`);
    if (scope.allowDevLogin) await tx.execute(sql`select set_config('app.allow_dev_login', 'on', true)`);
    return fn(tx);
  });
}

/** For pre-authentication lookups where no tenant is known yet (login). */
export async function withoutTenant<T>(db: Db, opts: { allowDevLogin?: boolean }, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    if (opts.allowDevLogin) await tx.execute(sql`select set_config('app.allow_dev_login', 'on', true)`);
    return fn(tx);
  });
}
