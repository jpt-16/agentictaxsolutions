import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { connect, withTenant, type Connection } from "./client";
import * as s from "./schema";
import { createTestTenant, TEST_APP_URL, TEST_OWNER_URL, TEST_WORKER_URL, type TestTenant } from "./testing";

let owner: Connection, app: Connection, worker: Connection;
let A: TestTenant, B: TestTenant;
const TYPE = () => `t.${randomUUID().slice(0, 8)}`; // unique per test so tests never claim each other's jobs

async function expectDbError(p: Promise<unknown>, re: RegExp) {
  try { await p; } catch (e) {
    let msg = ""; for (let c: any = e; c; c = c.cause) msg += `${c.message} | `;
    expect(msg).toMatch(re); return;
  }
  throw new Error("Expected rejection");
}
const enqueue = (t: TestTenant, type: string, payload: object = {}, extra: Partial<typeof s.jobs.$inferInsert> = {}) =>
  withTenant(app.db, { tenantId: t.tenantId }, (tx) => tx.insert(s.jobs).values({ tenantId: t.tenantId, type, payload, ...extra }).returning());
const claim = async (type: string[], who = "w1", limit = 10, lease = 600) =>
  (await worker.db.execute(sql`select * from jobs_claim(${who}, ${sql.raw(`ARRAY[${type.map((t) => `'${t}'`).join(",")}]::text[]`)}, ${limit}, ${lease})`)).rows as any[];
const state = async (id: string) =>
  (await owner.db.execute(sql`select status, attempts, last_error, locked_by from jobs where id = ${id}`)).rows[0] as any;

beforeAll(async () => {
  owner = connect(TEST_OWNER_URL, { max: 4 }); app = connect(TEST_APP_URL, { max: 4 }); worker = connect(TEST_WORKER_URL, { max: 8 });
  A = await createTestTenant(owner, "ja"); B = await createTestTenant(owner, "jb");
});
afterAll(async () => { await owner.close(); await app.close(); await worker.close(); });

describe("worker role", () => {
  it("has no direct table access at all", async () => {
    for (const table of ["jobs", "requests", "users", "files", "audit_events", "tenants"]) {
      await expectDbError(worker.db.execute(sql.raw(`select * from ${table} limit 1`)), /permission denied/i);
    }
    await expectDbError(worker.db.execute(sql`update jobs set status = 'succeeded'`), /permission denied/i);
  });

  it("claims jobs across tenants through the function only", async () => {
    const type = TYPE();
    await enqueue(A, type, { n: 1 }); await enqueue(B, type, { n: 2 });
    const got = await claim([type]);
    expect(got.map((j) => j.tenant_id).sort()).toEqual([A.tenantId, B.tenantId].sort());
    expect(got.every((j) => j.attempts === 1)).toBe(true);
  });
});

describe("app role and tenant isolation", () => {
  it("can enqueue and read its own jobs, but not change them or see other tenants'", async () => {
    const type = TYPE();
    const [job] = await enqueue(A, type);
    const seenByB = await withTenant(app.db, { tenantId: B.tenantId }, (tx) => tx.select().from(s.jobs));
    expect(seenByB.find((j) => j.id === job!.id)).toBeUndefined();
    await expectDbError(withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.execute(sql`update jobs set status = 'succeeded'`)), /permission denied/i);
    await expectDbError(withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.execute(sql`delete from jobs`)), /permission denied/i);
    await expectDbError(
      withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.insert(s.jobs).values({ tenantId: B.tenantId, type: "x" })), /./);
  });
});

describe("queue semantics", () => {
  it("never hands the same job to two workers (SKIP LOCKED) under concurrency", async () => {
    const type = TYPE();
    for (let i = 0; i < 20; i++) await enqueue(A, type, { i });
    const batches = await Promise.all(Array.from({ length: 6 }, (_, i) => claim([type], `w${i}`, 5)));
    const ids = batches.flat().map((j) => j.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  it("only claims requested types and respects run_after", async () => {
    const type = TYPE();
    await enqueue(A, type, {}, { runAfter: new Date(Date.now() + 3_600_000) });
    expect(await claim([type])).toHaveLength(0);
    expect(await claim([TYPE()])).toHaveLength(0);
  });

  it("completes only for the worker that holds the lease", async () => {
    const type = TYPE();
    const [job] = await enqueue(A, type);
    await claim([type], "owner-worker");
    const wrong = (await worker.db.execute(sql`select jobs_complete(${job!.id}, 'someone-else') as ok`)).rows[0] as any;
    expect(wrong.ok).toBe(false);
    const right = (await worker.db.execute(sql`select jobs_complete(${job!.id}, 'owner-worker') as ok`)).rows[0] as any;
    expect(right.ok).toBe(true);
    expect((await state(job!.id)).status).toBe("succeeded");
  });

  it("retries failures, then parks the job as dead after max attempts", async () => {
    const type = TYPE();
    const [job] = await enqueue(A, type, {}, { maxAttempts: 2 });
    await claim([type], "w");
    let r = (await worker.db.execute(sql`select jobs_fail(${job!.id}, 'w', 'boom 1', 0) as r`)).rows[0] as any;
    expect(r.r).toBe("queued");
    await claim([type], "w");
    r = (await worker.db.execute(sql`select jobs_fail(${job!.id}, 'w', 'boom 2', 0) as r`)).rows[0] as any;
    expect(r.r).toBe("dead");
    expect(await claim([type])).toHaveLength(0);
    expect(await state(job!.id)).toMatchObject({ status: "dead", attempts: 2, last_error: "boom 2" });
  });

  it("reclaims jobs from a crashed worker after the lease expires", async () => {
    const type = TYPE();
    const [job] = await enqueue(A, type);
    await claim([type], "crashed", 1, 600);
    expect(await claim([type], "other", 1, 600)).toHaveLength(0); // lease still valid
    const again = await claim([type], "other", 1, 0); // lease of 0s = expired
    expect(again).toHaveLength(1);
    expect(again[0].attempts).toBe(2);
    expect((await state(job!.id)).locked_by).toBe("other");
  });

  it("marks a job dead if its lease expires after the final attempt", async () => {
    const type = TYPE();
    const [job] = await enqueue(A, type, {}, { maxAttempts: 1 });
    await claim([type], "crashed", 1, 600);
    expect(await claim([type], "other", 1, 0)).toHaveLength(0);
    expect((await state(job!.id)).status).toBe("dead");
  });
});

describe("files table", () => {
  it("is tenant-isolated and immutable for the app role", async () => {
    const reqId = randomUUID(), itemId = randomUUID(), subId = randomUUID(), fileId = randomUUID();
    await withTenant(owner.db, { tenantId: A.tenantId }, async (tx) => {
      await tx.insert(s.requests).values({ id: reqId, tenantId: A.tenantId, reference: `F-${reqId.slice(0, 5)}`, title: "files", taxYear: 2025, dueDate: "2026-01-01", createdBy: A.users.manager });
      await tx.insert(s.requestItems).values({ id: itemId, tenantId: A.tenantId, requestId: reqId, position: 1, title: "i", dataType: "other" });
      await tx.insert(s.submissions).values({ id: subId, tenantId: A.tenantId, itemId, version: 1, submittedBy: A.users.contributor, note: "n" });
    });
    await withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.insert(s.files).values({
      id: fileId, tenantId: A.tenantId, submissionId: subId, originalName: "tb.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sizeBytes: 10, sha256: "a".repeat(64), storageKey: `${A.tenantId}/${fileId}`, scanner: "test", scannedAt: new Date(), uploadedBy: A.users.contributor }));
    expect(await withTenant(app.db, { tenantId: B.tenantId }, (tx) => tx.select().from(s.files))).toHaveLength(0);
    await expectDbError(withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.execute(sql`update files set original_name = 'x'`)), /permission denied/i);
    await expectDbError(withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.execute(sql`delete from files`)), /permission denied/i);
    // cross-tenant composite FK: a file in tenant B cannot hang off tenant A's submission
    await expectDbError(withTenant(owner.db, { tenantId: B.tenantId }, (tx) => tx.insert(s.files).values({
      tenantId: B.tenantId, submissionId: subId, originalName: "x", contentType: "x", sizeBytes: 1, sha256: "b".repeat(64), storageKey: "k", scanner: "t", scannedAt: new Date(), uploadedBy: B.users.manager })), /foreign key|violates/i);
  });
});
