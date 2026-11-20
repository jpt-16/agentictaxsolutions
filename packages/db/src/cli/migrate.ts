import { ownerUrl } from "../env";
import { runMigrations } from "../migrate";

await runMigrations(ownerUrl());
console.log("Migrations applied.");
