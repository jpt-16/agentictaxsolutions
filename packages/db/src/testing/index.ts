import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { connect, withTenant, type Connection } from "../client";
import { runMigrations } from "../migrate";
import * as s from "../schema";

export const TEST_OWNER_URL = process.env.TEST_DATABASE_OWNER_URL ?? "postgres://taxops_owner:taxops_owner@localhost:5433/taxops_test";
export const TEST_APP_URL = process.env.TEST_DATABASE_URL ?? "postgres://taxops_app:taxops_app@localhost:5433/taxops_test";

/** Drops everything in the test database and re-applies migrations from scratch. */
export async function resetTestDb(): Promise<void> {
  const owner = connect(TEST_OWNER_URL, { max: 1 });
  try {
    await owner.db.execute(sql`drop schema if exists public cascade`);
    await owner.db.execute(sql`drop schema if exists drizzle cascade`);
    await owner.db.execute(sql`create schema public authorization taxops_owner`);
    await owner.db.execute(sql`revoke all on schema public from public`);
    await owner.db.execute(sql`grant usage on schema public to taxops_app, taxops_worker`);
  } finally {
    await owner.close();
  }
  await runMigrations(TEST_OWNER_URL);
}

export interface TestTenant {
  tenantId: string;
  slug: string;
  entityId: string;
  departmentId: string;
  users: Record<"manager" | "reviewer" | "contributor" | "auditor" | "admin", string>;
}

/** Creates a tenant with one entity, one department and one user per role. Uses the owner connection. */
export async function createTestTenant(owner: Connection, label = "t"): Promise<TestTenant> {
  const tenantId = randomUUID();
  const slug = `${label}-${tenantId.slice(0, 8)}`;
  const entityId = randomUUID();
  const departmentId = randomUUID();
  const users = {
    manager: randomUUID(), reviewer: randomUUID(), contributor: randomUUID(), auditor: randomUUID(), admin: randomUUID(),
  };
  await withTenant(owner.db, { tenantId }, async (tx) => {
    await tx.insert(s.tenants).values({ id: tenantId, name: `Tenant ${slug}`, slug });
    await tx.insert(s.legalEntities).values({ id: entityId, tenantId, name: "Test Entity", code: "TE1", country: "US", currency: "USD" });
    await tx.insert(s.departments).values({ id: departmentId, tenantId, name: "Test Dept", code: "TD1" });
    await tx.insert(s.users).values([
      { id: users.manager, tenantId, email: `manager@${slug}.test`, name: "Mia Manager", role: "tax_manager" },
      { id: users.reviewer, tenantId, email: `reviewer@${slug}.test`, name: "Rob Reviewer", role: "tax_reviewer" },
      { id: users.contributor, tenantId, email: `contrib@${slug}.test`, name: "Cat Contributor", role: "contributor", departmentId, entityId },
      { id: users.auditor, tenantId, email: `auditor@${slug}.test`, name: "Al Auditor", role: "auditor" },
      { id: users.admin, tenantId, email: `admin@${slug}.test`, name: "Ada Admin", role: "tenant_admin" },
    ]);
  });
  return { tenantId, slug, entityId, departmentId, users };
}

export const TEST_WORKER_URL = process.env.TEST_WORKER_DATABASE_URL ?? "postgres://taxops_worker:taxops_worker@localhost:5433/taxops_test";

export interface FileFixture { requestId: string; itemId: string; submissionId: string; fileId: string; storageKey: string }

/** Inserts request → item → submission → file for a tenant (owner connection) so agent tests have something to point at. */
export async function createFileFixture(owner: Connection, t: TestTenant, name = "tb.xlsx"): Promise<FileFixture> {
  const requestId = randomUUID(), itemId = randomUUID(), submissionId = randomUUID(), fileId = randomUUID();
  const storageKey = `${t.tenantId}/${fileId}`;
  await withTenant(owner.db, { tenantId: t.tenantId }, async (tx) => {
    await tx.insert(s.requests).values({ id: requestId, tenantId: t.tenantId, reference: `AG-${requestId.slice(0, 6)}`, title: "Agent fixture", taxYear: 2025, dueDate: "2026-12-31", status: "open", createdBy: t.users.manager });
    await tx.insert(s.requestItems).values({ id: itemId, tenantId: t.tenantId, requestId, position: 1, title: "Trial balance", dataType: "trial_balance", status: "submitted" });
    await tx.insert(s.submissions).values({ id: submissionId, tenantId: t.tenantId, itemId, version: 1, submittedBy: t.users.contributor, note: "fixture" });
    await tx.insert(s.files).values({ id: fileId, tenantId: t.tenantId, submissionId, originalName: name, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sizeBytes: 100, sha256: "c".repeat(64), storageKey, scanner: "test", scannedAt: new Date(), uploadedBy: t.users.contributor });
  });
  return { requestId, itemId, submissionId, fileId, storageKey };
}
