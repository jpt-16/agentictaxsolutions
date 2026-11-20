import { connect, ownerUrl, tenants, withTenant } from "@taxops/db";
import { sql } from "drizzle-orm";

// Usage: pnpm tenant:flags <slug> [--ai on|off] [--external-llm on|off]
// Operator tool (connects as the owner role): tenants opt in to AI processing, and separately to external model providers.
const [slug, ...rest] = process.argv.slice(2);
const flag = (name: string) => { const i = rest.indexOf(name); const v = i >= 0 ? rest[i + 1] : undefined; return v === "on" ? true : v === "off" ? false : undefined; };
const ai = flag("--ai"), ext = flag("--external-llm");
if (!slug || (ai === undefined && ext === undefined)) { console.error("Usage: pnpm tenant:flags <slug> [--ai on|off] [--external-llm on|off]"); process.exit(1); }

const owner = connect(ownerUrl(), { max: 1 });
try {
  const found = (await owner.db.execute(sql`select id from tenants where slug = ${slug}`)).rows[0] as { id: string } | undefined;
  if (!found) { console.error(`No tenant "${slug}".`); process.exit(1); }
  await withTenant(owner.db, { tenantId: found.id }, async (tx) => {
    await tx.update(tenants).set({ ...(ai !== undefined && { aiExtractionEnabled: ai }), ...(ext !== undefined && { externalLlmEnabled: ext }) });
  });
  const now = (await withTenant(owner.db, { tenantId: found.id }, (tx) => tx.select({ a: tenants.aiExtractionEnabled, e: tenants.externalLlmEnabled }).from(tenants)))[0]!;
  console.log(`${slug}: AI extraction ${now.a ? "ON" : "off"}, external LLM ${now.e ? "ON" : "off"}`);
} finally { await owner.close(); }
