import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { connect } from "./client";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

export async function runMigrations(ownerUrl: string): Promise<void> {
  const conn = connect(ownerUrl, { max: 1 });
  try {
    await migrate(conn.db, { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await conn.close();
  }
}
