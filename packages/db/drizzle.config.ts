import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: { url: process.env.DATABASE_OWNER_URL ?? "postgres://taxops_owner:taxops_owner@localhost:5433/taxops" },
});
