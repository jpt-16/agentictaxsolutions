import { appUrl, connect, ownerUrl } from "@taxops/db";
import { resetDevDatabase } from "../reset-db";
import { rm } from "node:fs/promises";
import { seedDemo } from "../seed";
import { EicarScanner } from "../files/scanner";
import { LocalStorage, resolveStorageDir } from "../files/storage";

const storageDir = resolveStorageDir();
await resetDevDatabase(ownerUrl());
await rm(storageDir, { recursive: true, force: true }); // blobs from the wiped database would be orphans
const owner = connect(ownerUrl(), { max: 2 });
const app = connect(appUrl(), { max: 4 });
try {
  await seedDemo(owner, app, { slug: process.env.DEV_TENANT_SLUG ?? "northwind", files: { storage: new LocalStorage(storageDir), scanner: new EicarScanner() } });
  console.log("Database reset and reseeded with fictional demo data.");
} finally {
  await owner.close();
  await app.close();
}
