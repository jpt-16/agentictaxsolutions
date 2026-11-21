import { appUrl, connect, installDevLogin, ownerUrl } from "@taxops/db";
import { seedDemo } from "../seed";
import { EicarScanner } from "../files/scanner";
import { LocalStorage, resolveStorageDir } from "../files/storage";

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
