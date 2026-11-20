import { appUrl, connect, ownerUrl } from "@taxops/db";
import { seedDemo } from "../seed";

const owner = connect(ownerUrl(), { max: 2 });
const app = connect(appUrl(), { max: 4 });
try {
  const { slug } = await seedDemo(owner, app, { slug: process.env.DEV_TENANT_SLUG ?? "northwind" });
  console.log(`Seeded fictional demo tenant "${slug}".`);
} finally {
  await owner.close();
  await app.close();
}
