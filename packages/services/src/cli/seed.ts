import { appUrl, connect, ownerUrl } from "@taxops/db";
import path from "node:path";
import { seedDemo } from "../seed";
import { EicarScanner } from "../files/scanner";
import { LocalStorage } from "../files/storage";

const storageDir = process.env.STORAGE_DIR ?? path.resolve(process.cwd(), "../../.storage");
const owner = connect(ownerUrl(), { max: 2 });
const app = connect(appUrl(), { max: 4 });
try {
  const { slug } = await seedDemo(owner, app, { slug: process.env.DEV_TENANT_SLUG ?? "northwind", files: { storage: new LocalStorage(storageDir), scanner: new EicarScanner() } });
  console.log(`Seeded fictional demo tenant "${slug}".`);
} finally {
  await owner.close();
  await app.close();
}
