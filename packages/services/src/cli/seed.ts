import { appUrl, connect, installDevLogin, ownerUrl } from "@taxops/db";
import { seedDemo } from "../seed";
import { EicarScanner } from "../files/scanner";
import { LocalStorage, resolveStorageDir } from "../files/storage";

// Demo data is for local development only: never write it into a hosted database by accident.
const seedHost = new URL(ownerUrl()).hostname;
if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "db"].includes(seedHost)) {
  console.error(`Refusing to seed demo data into "${seedHost}". db:seed is for a local development database; your DATABASE_OWNER_URL points somewhere else.`);
  process.exit(1);
}
const storageDir = resolveStorageDir();
const owner = connect(ownerUrl(), { max: 2 });
const app = connect(appUrl(), { max: 4 });
try {
  if (process.env.AUTH_MODE === "dev" && process.env.NODE_ENV !== "production") await installDevLogin(owner.db);
  const { slug } = await seedDemo(owner, app, { slug: process.env.DEV_TENANT_SLUG ?? "northwind", files: { storage: new LocalStorage(storageDir), scanner: new EicarScanner() } });
  console.log(`Seeded fictional demo tenant "${slug}".`);
} finally {
  await owner.close();
  await app.close();
}
