import { appUrl, connect, ownerUrl } from "@taxops/db";
import { resetDevDatabase } from "../reset-db";
import { seedDemo } from "../seed";

await resetDevDatabase(ownerUrl());
const owner = connect(ownerUrl(), { max: 2 });
const app = connect(appUrl(), { max: 4 });
try {
  await seedDemo(owner, app, { slug: process.env.DEV_TENANT_SLUG ?? "northwind" });
  console.log("Database reset and reseeded with fictional demo data.");
} finally {
  await owner.close();
  await app.close();
}
