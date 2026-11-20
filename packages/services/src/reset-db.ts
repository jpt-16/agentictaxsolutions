import { sql } from "drizzle-orm";
import { connect } from "@taxops/db";
import { runMigrations } from "@taxops/db/src/migrate";

/** DESTROYS all data and rebuilds the schema. Development only; refuses anything that doesn't look local. */
export async function resetDevDatabase(ownerUrl: string): Promise<void> {
  const host = new URL(ownerUrl).hostname;
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "db"].includes(host)) {
    throw new Error(`Refusing to reset database on host "${host}" (NODE_ENV=${process.env.NODE_ENV}).`);
  }
  const owner = connect(ownerUrl, { max: 1 });
  try {
    await owner.db.execute(sql`drop schema if exists public cascade`);
    await owner.db.execute(sql`drop schema if exists drizzle cascade`);
    await owner.db.execute(sql`create schema public authorization taxops_owner`);
    await owner.db.execute(sql`revoke all on schema public from public`);
    await owner.db.execute(sql`grant usage on schema public to taxops_app, taxops_worker`);
  } finally {
    await owner.close();
  }
  await runMigrations(ownerUrl);
}
