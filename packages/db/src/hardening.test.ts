import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { connect, withTenant, type Connection } from "./client";
import { recordAudit } from "./audit";
import * as s from "./schema";
import { createFileFixture, createTestTenant, TEST_APP_URL, TEST_OWNER_URL, TEST_WORKER_URL, type TestTenant } from "./testing";

let owner: Connection, app: Connection, worker: Connection;
let A: TestTenant, B: TestTenant;
const rowsOf = async (q: ReturnType<typeof sql>) => (await owner.db.execute(q)).rows as any[];

async function expectDbError(p: Promise<unknown>, re: RegExp) {
  try { await p; } catch (e) {
    let msg = ""; for (let c: any = e; c; c = c.cause) msg += `${c.message} | `;
    expect(msg).toMatch(re); return;
  }
  throw new Error("Expected rejection");
}

beforeAll(async () => {
  owner = connect(TEST_OWNER_URL, { max: 4 }); app = connect(TEST_APP_URL, { max: 4 }); worker = connect(TEST_WORKER_URL, { max: 2 });
  A = await createTestTenant(owner, "ha"); B = await createTestTenant(owner, "hb");
});
afterAll(async () => { await owner.close(); await app.close(); await worker.close(); });

/* ===================================================================================================================
 * Structural guarantees, read from the live catalog. These fail if a future migration weakens isolation.
 * ================================================================================================================= */
describe("schema introspection: isolation can't silently regress", () => {
  const TENANT_TABLES = async () => (await rowsOf(sql`
    select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and (c.relname = 'tenants' or exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped))`)) as { name: string; rls: boolean; forced: boolean }[];

  it("every tenant-scoped table has row-level security enabled AND forced, plus at least one policy", async () => {
    const tables = await TENANT_TABLES();
    expect(tables.length).toBeGreaterThanOrEqual(17);
    const policies = await rowsOf(sql`select tablename, count(*)::int as n from pg_policies where schemaname = 'public' group by tablename`);
    for (const t of tables) {
      expect(t.rls, `${t.name} must have RLS enabled`).toBe(true);
      expect(t.forced, `${t.name} must FORCE RLS (so even the owner is bound)`).toBe(true);
      expect(policies.find((p) => p.tablename === t.name)?.n ?? 0, `${t.name} needs a policy`).toBeGreaterThan(0);
    }
  });

  it("every tenant isolation policy is keyed to the transaction's tenant setting", async () => {
    const pol = await rowsOf(sql`select tablename, policyname, qual from pg_policies where schemaname = 'public' and policyname in ('tenant_isolation', 'notif_select', 'notif_insert', 'notif_update')`);
    for (const p of pol) if (p.qual) expect(p.qual, `${p.tablename}.${p.policyname}`).toContain("app_tenant_id()");
  });

  it("the only policies that grant a role blanket access are the three that were reviewed", async () => {
    const wide = await rowsOf(sql`select tablename, policyname, roles::text as roles from pg_policies where schemaname = 'public' and qual = 'true' order by 1, 2`);
    expect(wide.map((r) => `${r.tablename}.${r.policyname}`)).toEqual(["jobs.worker_queue", "tenants.auth_lookup", "users.auth_lookup"]);
    for (const r of wide) expect(r.roles).toBe("{taxops_owner}");
  });

  it("every foreign key between tenant tables is composite with tenant_id, so a row can never point across tenants", async () => {
    const fks = await rowsOf(sql`
      select c.conrelid::regclass::text as child, c.conname, c.confrelid::regclass::text as parent,
             (select array_agg(a.attname order by a.attnum) from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any(c.conkey)) as cols
        from pg_constraint c
       where c.contype = 'f' and c.connamespace = 'public'::regnamespace and c.confrelid::regclass::text <> 'tenants'`);
    expect(fks.length).toBeGreaterThan(25);
    // jobs.id is referenced by agent_runs: jobs is a work queue the app cannot read across tenants and the FK is tenant-checked by RLS on insert.
    const exempt = new Set(["agent_runs_job_id_jobs_id_fk"]);
    for (const fk of fks) if (!exempt.has(fk.conname)) expect(fk.cols as string[], `${fk.child}.${fk.conname}`).toContain("tenant_id");
  });

  it("the application role has no TRUNCATE/REFERENCES/TRIGGER anywhere, and DELETE only where a trigger limits it to drafts", async () => {
    const g = await rowsOf(sql`select table_name, privilege_type from information_schema.role_table_grants where grantee = 'taxops_app' and table_schema = 'public'`);
    expect(g.filter((x) => ["TRUNCATE", "REFERENCES", "TRIGGER"].includes(x.privilege_type))).toEqual([]);
    expect(g.filter((x) => x.privilege_type === "DELETE").map((x) => x.table_name).sort()).toEqual(["assignments", "request_items"]);
    const draftGuards = await rowsOf(sql`select event_object_table as t from information_schema.triggers where trigger_name = 'draft_only_delete' and event_manipulation = 'DELETE'`);
    expect(draftGuards.map((x) => x.t).sort()).toEqual(["assignments", "request_items"]);
  });

  it("the audit table is insert/select only for the app, and protected by chain + immutability triggers", async () => {
    const g = await rowsOf(sql`select privilege_type from information_schema.role_table_grants where grantee = 'taxops_app' and table_name = 'audit_events' order by 1`);
    expect(g.map((x) => x.privilege_type)).toEqual(["INSERT", "SELECT"]);
    const trg = await rowsOf(sql`select tgname from pg_trigger where tgrelid = 'audit_events'::regclass and not tgisinternal order by 1`);
    expect(trg.map((t) => t.tgname)).toEqual(["audit_events_chain", "audit_events_no_truncate", "audit_events_no_update_delete"]);
  });

  it("the worker role has no table or column privileges at all", async () => {
    expect(await rowsOf(sql`select 1 from information_schema.role_table_grants where grantee = 'taxops_worker' and table_schema = 'public'`)).toEqual([]);
    expect(await rowsOf(sql`select 1 from information_schema.role_column_grants where grantee = 'taxops_worker' and table_schema = 'public'`)).toEqual([]);
  });

  it("every SECURITY DEFINER function pins its search_path and is not executable by PUBLIC", async () => {
    const fns = await rowsOf(sql`
      select p.proname, p.proconfig::text as cfg,
             exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec
        from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef order by 1`);
    expect(fns.map((f) => f.proname)).toEqual(expect.arrayContaining(["agent_get_file", "agent_save_results", "agent_get_proposal", "jobs_claim", "jobs_complete", "jobs_fail", "auth_resolve_user", "revoke_my_sessions", "ops_metrics", "proposals_notify"]));
    for (const f of fns) {
      expect(f.cfg, `${f.proname} must set search_path`).toContain("search_path");
      if (f.proname !== "proposals_notify") expect(f.public_exec, `${f.proname} must not be PUBLIC-executable`).toBe(false); // trigger functions are not callable directly
    }
  });

  it("the cross-tenant aggregate function is owned by the dedicated role, and nothing else bypasses RLS", async () => {
    expect((await rowsOf(sql`select pg_get_userbyid(proowner) as o from pg_proc where proname = 'ops_metrics'`))[0].o).toBe("taxops_ops");
    const bypass = await rowsOf(sql`select rolname from pg_roles where rolbypassrls or rolsuper order by 1`);
    expect(bypass.map((r) => r.rolname).filter((n) => n.startsWith("taxops_"))).toEqual(["taxops_ops"]);
    const cannotLogin = await rowsOf(sql`select rolcanlogin from pg_roles where rolname = 'taxops_ops'`);
    expect(cannotLogin[0].rolcanlogin).toBe(false);
  });

  it("the app role cannot create objects or change the schema", async () => {
    await expectDbError(app.db.execute(sql`create table sneaky (id int)`), /permission denied/i);
    await expectDbError(app.db.execute(sql`create function sneaky() returns int language sql as 'select 1'`), /permission denied/i);
  });
});

/* ===================================================================================================================
 * Notifications
 * ================================================================================================================= */
describe("notifications", () => {
  const notify = (t: TestTenant, to: string, title = "Hello", key?: string, userId = t.users.manager) =>
    withTenant(app.db, { tenantId: t.tenantId, userId }, (tx) => tx.insert(s.notifications).values({ tenantId: t.tenantId, userId: to, type: "t", title, dedupeKey: key }).onConflictDoNothing());
  const inbox = (t: TestTenant, userId: string) => withTenant(app.db, { tenantId: t.tenantId, userId }, (tx) => tx.select().from(s.notifications));

  it("anyone in the tenant may create one, but only the recipient can read it", async () => {
    await notify(A, A.users.contributor, "For Cat");
    expect((await inbox(A, A.users.contributor)).map((n) => n.title)).toContain("For Cat");
    expect((await inbox(A, A.users.manager)).map((n) => n.title)).not.toContain("For Cat");
    expect(await withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.select().from(s.notifications))).toHaveLength(0); // no acting user -> nothing
    expect((await inbox(B, B.users.contributor)).map((n) => n.title)).not.toContain("For Cat");
  });

  it("can be created only inside one's own tenant and only for users of that tenant", async () => {
    await expectDbError(withTenant(app.db, { tenantId: A.tenantId, userId: A.users.manager }, (tx) => tx.insert(s.notifications).values({ tenantId: B.tenantId, userId: B.users.manager, type: "t", title: "x" })), /row-level security|policy/i);
    await expectDbError(notify(A, B.users.contributor), /foreign key|violates/i);
  });

  it("the recipient can mark read (only that column); others cannot, and content is immutable", async () => {
    await notify(A, A.users.reviewer, "Mark me");
    const mine = (await inbox(A, A.users.reviewer)).find((n) => n.title === "Mark me")!;
    await expectDbError(withTenant(app.db, { tenantId: A.tenantId, userId: A.users.reviewer }, (tx) => tx.execute(sql`update notifications set title = 'edited' where id = ${mine.id}`)), /permission denied/i);
    const other = await withTenant(app.db, { tenantId: A.tenantId, userId: A.users.manager }, (tx) => tx.update(s.notifications).set({ readAt: new Date() }).where(sql`${s.notifications.id} = ${mine.id}`).returning());
    expect(other).toHaveLength(0);
    await withTenant(app.db, { tenantId: A.tenantId, userId: A.users.reviewer }, (tx) => tx.update(s.notifications).set({ readAt: new Date() }).where(sql`${s.notifications.id} = ${mine.id}`));
    expect((await inbox(A, A.users.reviewer)).find((n) => n.id === mine.id)!.readAt).toBeInstanceOf(Date);
  });

  it("is idempotent per dedupe key (sweeps and retries never double-notify)", async () => {
    await notify(A, A.users.auditor, "Once", "k1"); await notify(A, A.users.auditor, "Once", "k1");
    expect((await inbox(A, A.users.auditor)).filter((n) => n.title === "Once")).toHaveLength(1);
  });

  it("agent output notifies tax managers and reviewers (and nobody else) through the database", async () => {
    const f = await createFileFixture(owner, A);
    const type = `notif.${randomUUID().slice(0, 6)}`;
    await withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.insert(s.jobs).values({ tenantId: A.tenantId, type, payload: { fileId: f.fileId } }));
    const job = ((await worker.db.execute(sql`select id from jobs_claim('w1', ARRAY[${type}]::text[], 1, 600)`)).rows[0] as any).id;
    await worker.db.execute(sql`select agent_save_results(${job}::uuid, 'w1', 'extraction', '1', '{"status":"succeeded"}'::jsonb,
      ${JSON.stringify([{ kind: "extraction", schema_key: "trial_balance", title: "Notify me TB", payload: { sheet: "S" }, confidence: 0.9, severity: "info" }])}::jsonb, '[]'::jsonb)`);
    for (const who of [A.users.manager, A.users.reviewer]) expect((await inbox(A, who)).some((n) => n.title === "New AI result to review" && n.body === "Notify me TB")).toBe(true);
    for (const who of [A.users.contributor, A.users.auditor, A.users.admin]) expect((await inbox(A, who)).some((n) => n.body === "Notify me TB")).toBe(false);
    expect((await inbox(B, B.users.manager)).some((n) => n.body === "Notify me TB")).toBe(false);
  });
});

/* ===================================================================================================================
 * Administration enforced by the database
 * ================================================================================================================= */
describe("user administration is enforced in the database", () => {
  const edit = (t: TestTenant, by: string | undefined, q: ReturnType<typeof sql>) => withTenant(app.db, { tenantId: t.tenantId, userId: by }, (tx) => tx.execute(q));

  it("only tenant admins can create or edit users, and never email or tenant", async () => {
    const id = randomUUID();
    const create = (by?: string) => edit(A, by, sql`insert into users (id, tenant_id, email, name, role) values (${id}, ${A.tenantId}, ${`new-${id.slice(0, 6)}@x.test`}, 'New Person', 'contributor')`);
    for (const who of [undefined, A.users.manager, A.users.reviewer, A.users.contributor]) await expectDbError(create(who), /only tenant admins may manage users/);
    await create(A.users.admin);
    await edit(A, A.users.admin, sql`update users set title = 'Analyst', role = 'tax_reviewer' where id = ${id}`);
    await expectDbError(edit(A, A.users.admin, sql`update users set email = 'hijack@x.test' where id = ${id}`), /permission denied/i);
    await expectDbError(edit(A, A.users.admin, sql`update users set tenant_id = ${B.tenantId} where id = ${id}`), /permission denied/i);
    await expectDbError(edit(A, A.users.manager, sql`update users set role = 'tenant_admin' where id = ${id}`), /only tenant admins/);
  });

  it("an admin cannot demote or deactivate themselves, and the last admin can never be removed", async () => {
    await expectDbError(edit(A, A.users.admin, sql`update users set role = 'contributor' where id = ${A.users.admin}`), /cannot change your own role/);
    await expectDbError(edit(A, A.users.admin, sql`update users set is_active = false where id = ${A.users.admin}`), /cannot change your own role/);
    const second = randomUUID();
    await edit(A, A.users.admin, sql`insert into users (id, tenant_id, email, name, role) values (${second}, ${A.tenantId}, ${`adm2-${second.slice(0, 6)}@x.test`}, 'Second Admin', 'tenant_admin')`);
    await edit(A, second, sql`update users set role = 'tax_manager' where id = ${A.users.admin}`); // allowed: another admin remains (the second)
    await expectDbError(edit(A, second, sql`update users set is_active = false where id = ${second}`), /cannot change your own role/);
    // restore the original admin so later tests are unaffected
    await withTenant(owner.db, { tenantId: A.tenantId }, (tx) => tx.execute(sql`update users set role = 'tenant_admin' where id = ${A.users.admin}`));
  });

  it("cannot reach users of other tenants", async () => {
    expect((await edit(B, B.users.admin, sql`update users set title = 'x' where id = ${A.users.contributor} returning id`)).rows).toHaveLength(0);
  });
});

describe("draft-only deletes", () => {
  async function request(t: TestTenant, status: "draft" | "open") {
    const id = randomUUID(), itemId = randomUUID();
    await withTenant(owner.db, { tenantId: t.tenantId }, async (tx) => {
      await tx.insert(s.requests).values({ id, tenantId: t.tenantId, reference: `D-${id.slice(0, 6)}`, title: "x", taxYear: 2025, dueDate: "2026-12-31", status, createdBy: t.users.manager });
      await tx.insert(s.requestItems).values({ id: itemId, tenantId: t.tenantId, requestId: id, position: 1, title: "i", dataType: "other" });
      await tx.insert(s.assignments).values({ tenantId: t.tenantId, requestId: id, assigneeType: "user", userId: t.users.contributor });
    });
    return { id, itemId };
  }
  it("lets the app delete items and assignments of a DRAFT request only", async () => {
    const draft = await request(A, "draft"), open = await request(A, "open");
    const del = (q: ReturnType<typeof sql>) => withTenant(app.db, { tenantId: A.tenantId, userId: A.users.manager }, (tx) => tx.execute(q));
    await del(sql`delete from request_items where request_id = ${draft.id}`); await del(sql`delete from assignments where request_id = ${draft.id}`);
    await expectDbError(del(sql`delete from request_items where request_id = ${open.id}`), /published request cannot be deleted/);
    await expectDbError(del(sql`delete from assignments where request_id = ${open.id}`), /published request cannot be deleted/);
  });
});

/* ===================================================================================================================
 * Audit export + ops metrics
 * ================================================================================================================= */
describe("audit export", () => {
  it("each row carries the exact text that was hashed, so SHA-256 alone re-derives the chain", async () => {
    const t = await createTestTenant(owner, "ex");
    for (let i = 1; i <= 4; i++) await withTenant(app.db, { tenantId: t.tenantId }, (tx) => recordAudit(tx, { tenantId: t.tenantId, actor: { type: "system", id: null, label: "t" }, action: "x.y", entityType: "x", entityId: null, summary: `n${i}`, before: { i: i - 1, nested: { b: 1, a: [1, 2] } }, after: { i, amount: 0.5 } }));
    const rows = (await withTenant(app.db, { tenantId: t.tenantId }, (tx) => tx.execute(sql`select seq, prev_hash, hash, audit_canonical(e) as canonical from audit_events e order by seq`))).rows as any[];
    expect(rows).toHaveLength(4);
    let prev = "0".repeat(64);
    for (const r of rows) {
      expect(r.prev_hash).toBe(prev);
      expect(createHash("sha256").update(r.canonical, "utf8").digest("hex")).toBe(r.hash);
      expect(JSON.parse(r.canonical)[0]).toBe(prev); // the canonical text itself embeds the previous hash
      prev = r.hash;
    }
  });
});

describe("ops metrics", () => {
  it("returns aggregate counts only, to the app role, without exposing any tenant's rows", async () => {
    const m = ((await app.db.execute(sql`select ops_metrics() as m`)).rows[0] as any).m;
    expect(Object.keys(m).sort()).toEqual(["audit_events", "dead_jobs", "jobs", "oldest_queued_seconds", "proposals_pending", "tenants"]);
    expect(m.tenants).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(m)).not.toMatch(/@|uuid|tenant_id/);
    await expectDbError(worker.db.execute(sql`select ops_metrics()`), /permission denied/i);
  });
});

/* ===================================================================================================================
 * Audit finding #1: the app role may change ONLY these columns. Evidence (reviews, submissions, comments) is immutable.
 * ================================================================================================================= */
describe("write access is pinned to exactly what the application needs", () => {
  it("has no table-wide UPDATE anywhere, and column-level UPDATE only on the reviewed list", async () => {
    const tableWide = await rowsOf(sql`select table_name from information_schema.role_table_grants where grantee = 'taxops_app' and privilege_type = 'UPDATE' and table_schema = 'public' order by 1`);
    expect(tableWide.map((r) => r.table_name)).toEqual([]);
    const cols = await rowsOf(sql`select table_name, string_agg(column_name, ',' order by column_name) as cols from information_schema.column_privileges
      where grantee = 'taxops_app' and privilege_type = 'UPDATE' and table_schema = 'public' group by 1 order by 1`);
    expect(Object.fromEntries(cols.map((r) => [r.table_name, r.cols]))).toEqual({
      notifications: "read_at",
      request_templates: "archived_at",
      proposals: "decided_at,decided_by,decision_note,status",
      request_items: "status,updated_at",
      requests: "closed_at,description,due_date,priority,published_at,status,tax_year,title,updated_at",
      rule_settings: "enabled,params",
      tenants: "ai_extraction_enabled,external_llm_enabled",
      users: "department_id,entity_id,is_active,name,role,title",
    });
  });

  it("cannot rewrite review decisions, submission notes, comments, references or assignments", async () => {
    const f = await createFileFixture(owner, A);
    const as = (q: ReturnType<typeof sql>) => withTenant(app.db, { tenantId: A.tenantId, userId: A.users.manager }, (tx) => tx.execute(q));
    for (const q of [
      sql`update reviews set decision = 'approved'`, sql`update submissions set note = 'rewritten'`, sql`update comments set body = 'rewritten'`,
      sql`update requests set reference = 'X' where id = ${f.requestId}`, sql`update requests set created_by = ${A.users.reviewer} where id = ${f.requestId}`,
      sql`update assignments set user_id = ${A.users.contributor}`, sql`update departments set name = 'renamed'`, sql`update legal_entities set name = 'renamed'`,
      sql`update request_items set request_id = request_id`,
    ]) await expectDbError(as(q), /permission denied/i);
  });

  it("a published request's content cannot be edited even with column access", async () => {
    const f = await createFileFixture(owner, A); // fixture requests are 'open'
    await expectDbError(withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.execute(sql`update requests set title = 'changed after publishing' where id = ${f.requestId}`)), /cannot be edited/);
    await withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.execute(sql`update requests set status = 'in_progress' where id = ${f.requestId}`)); // workflow still works
  });

  it("the notification trigger leaves the caller's tenant setting as it found it", async () => {
    const f = await createFileFixture(owner, A);
    const after = await withTenant(owner.db, { tenantId: B.tenantId }, async (tx) => {
      const run = randomUUID(), job = randomUUID();
      await tx.execute(sql`select set_config('app.tenant_id', ${A.tenantId}, true)`);
      await tx.execute(sql`insert into jobs (id, tenant_id, type, payload, status) values (${job}, ${A.tenantId}, 'x', '{}', 'succeeded')`);
      await tx.insert(s.agentRuns).values({ id: run, tenantId: A.tenantId, jobId: job, agentName: "x", agentVersion: "1", event: "x", fileId: f.fileId, status: "succeeded" });
      await tx.execute(sql`select set_config('app.tenant_id', ${B.tenantId}, true)`); // caller is now in B ...
      await tx.execute(sql`select set_config('app.tenant_id', ${A.tenantId}, true)`);
      await tx.insert(s.proposals).values({ tenantId: A.tenantId, runId: run, fileId: f.fileId, requestId: f.requestId, itemId: f.itemId, kind: "extraction", title: "t", payload: {}, confidence: "0.5" });
      return ((await tx.execute(sql`select current_setting('app.tenant_id', true) as t`)).rows[0] as any).t;
    });
    expect(after).toBe(A.tenantId);
  });
});
