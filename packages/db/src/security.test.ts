import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { connect, withTenant, withoutTenant, type Connection } from "./client";
import { recordAudit, verifyAuditChain } from "./audit";
import * as s from "./schema";
import { createTestTenant, TEST_APP_URL, TEST_OWNER_URL, type TestTenant } from "./testing";

let owner: Connection;
let app: Connection;
let A: TestTenant;
let B: TestTenant;


/** Drizzle wraps driver errors ("Failed query: ..."); assert against the whole cause chain. */
async function expectDbError(p: Promise<unknown>, re: RegExp) {
  try {
    await p;
  } catch (e) {
    let msg = "";
    for (let cur: any = e; cur; cur = cur.cause) msg += `${cur.message} | `;
    expect(msg).toMatch(re);
    return;
  }
  throw new Error("Expected the operation to be rejected, but it succeeded");
}

const system = { type: "system", id: null, label: "test" } as const;

async function makeRequest(tenant: TestTenant, title: string) {
  const id = randomUUID();
  await withTenant(owner.db, { tenantId: tenant.tenantId }, (tx) =>
    tx.insert(s.requests).values({
      id, tenantId: tenant.tenantId, reference: `R-${id.slice(0, 6)}`, title, taxYear: 2025,
      dueDate: "2026-03-31", createdBy: tenant.users.manager,
    }),
  );
  return id;
}

beforeAll(async () => {
  owner = connect(TEST_OWNER_URL, { max: 4 });
  app = connect(TEST_APP_URL, { max: 8 });
  A = await createTestTenant(owner, "a");
  B = await createTestTenant(owner, "b");
});
afterAll(async () => {
  await owner.close();
  await app.close();
});

describe("tenant isolation (RLS)", () => {
  it("only returns the current tenant's rows", async () => {
    await makeRequest(A, "A request");
    await makeRequest(B, "B request");
    const seenByA = await withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.select().from(s.requests));
    expect(seenByA.length).toBeGreaterThan(0);
    expect(seenByA.every((r) => r.tenantId === A.tenantId)).toBe(true);
    const users = await withTenant(app.db, { tenantId: B.tenantId }, (tx) => tx.select().from(s.users));
    expect(users.every((u) => u.tenantId === B.tenantId)).toBe(true);
  });

  it("fails closed: no tenant context means no rows", async () => {
    const rows = await app.db.select().from(s.requests);
    expect(rows).toHaveLength(0);
    const tenants = await app.db.select().from(s.tenants);
    expect(tenants).toHaveLength(0);
  });

  it("cannot read another tenant's row by id", async () => {
    const bId = await makeRequest(B, "B secret");
    const rows = await withTenant(app.db, { tenantId: A.tenantId }, (tx) =>
      tx.select().from(s.requests).where(sql`${s.requests.id} = ${bId}`));
    expect(rows).toHaveLength(0);
  });

  it("cannot insert a row into another tenant", async () => {
    await expectDbError(
      withTenant(app.db, { tenantId: A.tenantId }, (tx) =>
        tx.insert(s.requests).values({
          tenantId: B.tenantId, reference: "X-1", title: "smuggled", taxYear: 2025, dueDate: "2026-01-01", createdBy: B.users.manager,
        })),
    /./);
  });

  it("cannot update or hijack another tenant's rows", async () => {
    const bId = await makeRequest(B, "B untouchable");
    const updated = await withTenant(app.db, { tenantId: A.tenantId }, (tx) =>
      tx.update(s.requests).set({ title: "pwned" }).where(sql`${s.requests.id} = ${bId}`).returning());
    expect(updated).toHaveLength(0);
    // moving one of my rows into another tenant is also rejected by WITH CHECK
    const aId = await makeRequest(A, "A mine");
    await expectDbError(
      withTenant(app.db, { tenantId: A.tenantId }, (tx) =>
        tx.update(s.requests).set({ tenantId: B.tenantId }).where(sql`${s.requests.id} = ${aId}`)),
    /./);
  });

  it("composite foreign keys stop a child row pointing at another tenant's parent", async () => {
    const bRequest = await makeRequest(B, "B parent");
    await expectDbError(
      withTenant(owner.db, { tenantId: A.tenantId }, (tx) =>
        tx.insert(s.requestItems).values({
          tenantId: A.tenantId, requestId: bRequest, position: 1, title: "cross-tenant item", dataType: "other",
        })),
    /foreign key|violates/i);
  });

  it("tenant setting does not leak between pooled transactions", async () => {
    await withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.select().from(s.users));
    const after = await app.db.select().from(s.users); // same pool, no context
    expect(after).toHaveLength(0);
  });
});

describe("least privilege for the app role", () => {
  it("cannot delete business rows", async () => {
    const id = await makeRequest(A, "undeletable");
    await expectDbError(
      withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.execute(sql`delete from requests where id = ${id}`)),
    /permission denied/i);
  });

  it("cannot create tenants", async () => {
    await expectDbError(
      withTenant(app.db, { tenantId: randomUUID() }, (tx) => tx.execute(sql`insert into tenants (name, slug) values ('x', 'x')`)),
    /./);
  });

  it("cannot alter the schema", async () => {
    await expectDbError(app.db.execute(sql`alter table requests disable row level security`), /must be owner/i);
  });

  it("cannot call dev-login helper unless dev login is enabled", async () => {
    await expectDbError(withoutTenant(app.db, {}, (tx) => tx.execute(sql`select * from auth_dev_list_users(${A.slug})`)), /disabled/);
    const rows = await withoutTenant(app.db, { allowDevLogin: true }, (tx) => tx.execute(sql`select * from auth_dev_list_users(${A.slug})`));
    expect(rows.rows).toHaveLength(5);
  });

  it("resolves a user by email for login without exposing other columns", async () => {
    const res = await withoutTenant(app.db, {}, (tx) => tx.execute(sql`select * from auth_resolve_user(${`manager@${A.slug}.test`})`));
    expect(res.rows).toHaveLength(1);
    expect(Object.keys(res.rows[0]!).sort()).toEqual(["is_active", "role", "tenant_id", "user_id"]);
  });
});

describe("audit trail", () => {
  const log = (tenant: TestTenant, n: number) =>
    withTenant(app.db, { tenantId: tenant.tenantId }, (tx) =>
      recordAudit(tx, {
        tenantId: tenant.tenantId, actor: system, action: "test.event", entityType: "test", entityId: null,
        summary: `event ${n}`, before: { n: n - 1 }, after: { n },
      }));

  it("assigns sequence, timestamps and hashes in the database, ignoring caller values", async () => {
    await withTenant(app.db, { tenantId: A.tenantId }, (tx) =>
      tx.execute(sql`insert into audit_events (tenant_id, seq, actor_type, actor_label, action, entity_type, summary, prev_hash, hash, occurred_at)
                     values (${A.tenantId}, 999, 'system', 'forger', 'forged.event', 'x', 'forged', 'aaaa', 'bbbb', '2001-01-01')`));
    const rows = await withTenant(app.db, { tenantId: A.tenantId }, (tx) =>
      tx.select().from(s.auditEvents).where(sql`${s.auditEvents.action} = 'forged.event'`));
    expect(rows[0]!.seq).not.toBe(999);
    expect(rows[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.occurredAt.getUTCFullYear()).toBeGreaterThan(2020);
  });

  it("builds a verifiable chain", async () => {
    for (let i = 1; i <= 5; i++) await log(B, i);
    const result = await withTenant(app.db, { tenantId: B.tenantId }, (tx) => verifyAuditChain(tx, B.tenantId));
    expect(result.ok).toBe(true);
    expect(result.checked).toBeGreaterThanOrEqual(5);
  });

  it("keeps a gap-free chain under concurrent writers", async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => log(A, i + 1)));
    const result = await withTenant(app.db, { tenantId: A.tenantId }, (tx) => verifyAuditChain(tx, A.tenantId));
    expect(result.ok).toBe(true);
    expect(result.checked).toBeGreaterThanOrEqual(25);
  });

  it("is append-only for the app role and for triggers", async () => {
    await log(A, 1);
    await expectDbError(
      withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.execute(sql`update audit_events set summary = 'edited'`)),
    /permission denied/i);
    await expectDbError(
      withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.execute(sql`delete from audit_events`)),
    /permission denied/i);
    // even the table owner is stopped by the immutability trigger
    await expectDbError(
      withTenant(owner.db, { tenantId: A.tenantId }, (tx) => tx.execute(sql`update audit_events set summary = 'edited'`)),
    /append-only/);
    await expectDbError(owner.db.execute(sql`truncate audit_events`), /append-only/);
  });

  it("detects tampering, even by someone who bypasses the triggers", async () => {
    const t = await createTestTenant(owner, "tamper");
    for (let i = 1; i <= 4; i++) await log(t, i);
    expect((await withTenant(app.db, { tenantId: t.tenantId }, (tx) => verifyAuditChain(tx, t.tenantId))).ok).toBe(true);

    // Simulate a privileged attacker with schema access: disable the guard, edit event #2, re-enable.
    await owner.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${t.tenantId}, true)`);
      await tx.execute(sql`alter table audit_events disable trigger audit_events_no_update_delete`);
      await tx.execute(sql`update audit_events set summary = 'rewritten history' where tenant_id = ${t.tenantId} and seq = 2`);
      await tx.execute(sql`alter table audit_events enable trigger audit_events_no_update_delete`);
    });
    const result = await withTenant(app.db, { tenantId: t.tenantId }, (tx) => verifyAuditChain(tx, t.tenantId));
    expect(result).toMatchObject({ ok: false, brokenSeq: 2 });
  });

  it("one tenant cannot read another tenant's audit events", async () => {
    const seen = await withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.select().from(s.auditEvents));
    expect(seen.every((e) => e.tenantId === A.tenantId)).toBe(true);
  });
});
