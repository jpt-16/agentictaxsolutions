import { randomUUID } from "node:crypto";
import { connect, ownerUrl, tenants, users, withTenant } from "@taxops/db";
import { sql } from "drizzle-orm";

// Usage: pnpm tenant:create --slug acme --name "Acme Corp" --admin-email jane@acme.com --admin-name "Jane Doe"
// Operator tool (connects as the owner role). Creates an empty tenant and its first tenant admin, who then signs in through SSO
// and adds everyone else from Settings. AI processing and external model providers both start OFF.
const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const slug = arg("--slug"), name = arg("--name"), email = arg("--admin-email")?.trim().toLowerCase(), adminName = arg("--admin-name");
const usage = 'Usage: pnpm tenant:create --slug <lowercase-slug> --name "<Organization>" --admin-email <email> --admin-name "<Full name>"';
if (!slug || !name || !email || !adminName) { console.error(usage); process.exit(1); }
if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(slug)) { console.error("The slug must be 1-40 characters: lowercase letters, digits and hyphens."); process.exit(1); }
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) { console.error("The admin email does not look valid."); process.exit(1); }
if (name.length > 120 || adminName.length > 120 || /[\u0000-\u001f\u007f]/.test(name + adminName)) { console.error("Names must be under 120 characters and contain no control characters."); process.exit(1); }

const owner = connect(ownerUrl(), { max: 1 });
try {
  const taken = (await owner.db.execute(sql`select 1 from tenants where slug = ${slug}`)).rows.length > 0
    || (await owner.db.execute(sql`select 1 from users where email = ${email}`)).rows.length > 0;
  if (taken) { console.error("That slug or admin email is already in use."); process.exit(1); }
  const tenantId = randomUUID();
  await withTenant(owner.db, { tenantId }, async (tx) => {
    await tx.insert(tenants).values({ id: tenantId, name, slug, aiExtractionEnabled: false, externalLlmEnabled: false });
    await tx.insert(users).values({ id: randomUUID(), tenantId, name: adminName, email, title: "Tenant administrator", role: "tenant_admin" });
  });
  console.log(`Created tenant "${slug}" with admin ${email}. AI processing is off; enable it with: pnpm tenant:flags ${slug} --ai on`);
} finally { await owner.close(); }
