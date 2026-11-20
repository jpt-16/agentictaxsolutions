import { sql } from "drizzle-orm";
import type { Db } from "./client";

export interface OpsMetrics {
  jobs: Record<string, number>;
  oldest_queued_seconds: number;
  dead_jobs: number;
  proposals_pending: number;
  tenants: number;
  audit_events: number;
}

/** Aggregate platform counts from `ops_metrics()` (no tenant content). Throws if the database is unreachable. */
export async function opsMetrics(db: Db): Promise<OpsMetrics> {
  const row = (await db.execute(sql`select ops_metrics() as m`)).rows[0] as { m: OpsMetrics };
  return row.m;
}
