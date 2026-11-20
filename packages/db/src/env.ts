import { config } from "dotenv";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

// Load the repo-root .env for CLI usage (Next.js loads its own).
let dir = process.cwd();
for (let i = 0; i < 5; i++) {
  const candidate = resolve(dir, ".env");
  if (existsSync(candidate)) { config({ path: candidate, quiet: true }); break; }
  dir = dirname(dir);
}

export const ownerUrl = () =>
  process.env.DATABASE_OWNER_URL ?? "postgres://taxops_owner:taxops_owner@localhost:5433/taxops";
export const appUrl = () =>
  process.env.DATABASE_URL ?? "postgres://taxops_app:taxops_app@localhost:5433/taxops";
