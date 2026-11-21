/**
 * Double-clicks and races: the same action fired many times at once, or two people deciding the same thing at the same moment.
 * Exactly one must win; nothing may be duplicated, and no raw database error may reach the caller.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { agentRuns, connect, jobs, proposals, withTenant, type Connection } from "@taxops/db";
import { createFileFixture, createTestTenant, TEST_APP_URL, TEST_OWNER_URL, type TestTenant } from "@taxops/db/src/testing";
import { addComment, closeRequest, createRequest, decideProposal, getRequestDetail, loadSession, publishRequest, reviewItem, submitItem, type ServiceContext } from "./index";

let owner: Connection, app: Connection, A: TestTenant;
const ctxFor = async (id: string): Promise<ServiceContext> => ({ db: app.db, session: (await loadSession(app.db, A.tenantId, id))! });
const CLEAN = new Set(["InvalidTransitionError", "ConflictError", "NotFoundError", "ForbiddenError"]);
const settle = async (n: number, fn: (i: number) => Promise<unknown>) => {
  const r = await Promise.allSettled(Array.from({ length: n }, (_, i) => fn(i)));
  const ok = r.filter((x) => x.status === "fulfilled").length;
  const errs = r.filter((x): x is PromiseRejectedResult => x.status === "rejected").map((x) => x.reason as Error);
  const raw = errs.filter((e) => !CLEAN.has(e.name)).map((e) => `${e.name}: ${e.message.slice(0, 120)}`);
  return { ok, failed: errs.length, raw };
};
const newRequest = async (items = 1) => {
  const mgr = await ctxFor(A.users.manager);
  const r = await createRequest(mgr, { title: `Race ${randomUUID().slice(0, 6)}`, taxYear: 2025, dueDate: "2027-01-01", items: Array.from({ length: items }, (_, i) => ({ title: `Item ${i + 1}`, dataType: "other" as const })), assignees: [{ type: "department", id: A.departmentId }] });
  return { id: r.id, mgr };
};
const count = async (q: ReturnType<typeof sql>) => Number(((await withTenant(owner.db, { tenantId: A.tenantId }, (tx) => tx.execute(q))).rows[0] as { n: string | number }).n);

beforeAll(async () => { owner = connect(TEST_OWNER_URL, { max: 4 }); app = connect(TEST_APP_URL, { max: 16 }); A = await createTestTenant(owner, "race"); });
afterAll(async () => { await owner.close(); await app.close(); });

describe("races and double submits", () => {
  it("publishing the same draft five times at once publishes it once, notifies once, and audits once", async () => {
    const { id, mgr } = await newRequest();
    const res = await settle(5, () => publishRequest(mgr, id));
    expect(res.ok).toBe(1); expect(res.raw).toEqual([]);
    expect(await count(sql`select count(*) n from audit_events where action = 'request.published' and request_ref = ${id}`)).toBe(1);
    expect(await count(sql`select count(*) n from notifications where link = ${"/requests/" + id} and type = 'request.assigned'`)).toBeLessThanOrEqual(await count(sql`select count(*) n from users where role = 'contributor' and is_active`));
  });

  it("a contributor double-clicking Submit creates one submission", async () => {
    const { id, mgr } = await newRequest(); await publishRequest(mgr, id);
    const item = (await getRequestDetail(mgr, id)).items[0]!.id, con = await ctxFor(A.users.contributor);
    const res = await settle(6, () => submitItem(con, item, { note: "double click" }));
    expect(res.ok).toBe(1); expect(res.raw).toEqual([]);
    expect(await count(sql`select count(*) n from submissions where item_id = ${item}`)).toBe(1);
  });

  it("an approval and a change request on the same item at the same moment: exactly one decision is recorded", async () => {
    const { id, mgr } = await newRequest(); await publishRequest(mgr, id);
    const item = (await getRequestDetail(mgr, id)).items[0]!.id;
    await submitItem(await ctxFor(A.users.contributor), item, { note: "ready for review" });
    const rev = await ctxFor(A.users.reviewer), mgr2 = await ctxFor(A.users.manager);
    const res = await settle(6, (i) => reviewItem(i % 2 ? rev : mgr2, item, i % 3 ? { decision: "approved" } : { decision: "changes_requested", rationale: "fix it" }));
    expect(res.ok).toBe(1); expect(res.raw).toEqual([]);
    expect(await count(sql`select count(*) n from reviews r join submissions s on s.id = r.submission_id where s.item_id = ${item}`)).toBe(1);
  });

  it("closing an approved request three times closes it once", async () => {
    const { id, mgr } = await newRequest(); await publishRequest(mgr, id);
    const item = (await getRequestDetail(mgr, id)).items[0]!.id;
    await submitItem(await ctxFor(A.users.contributor), item, { note: "ready for review" });
    await reviewItem(await ctxFor(A.users.reviewer), item, { decision: "approved" });
    const res = await settle(3, () => closeRequest(mgr, id));
    expect(res.ok).toBe(1); expect(res.raw).toEqual([]);
    expect(await count(sql`select count(*) n from audit_events where action = 'request.closed' and request_ref = ${id}`)).toBe(1);
  });

  it("twenty requests created at once get twenty distinct, gap-free reference numbers", async () => {
    const mgr = await ctxFor(A.users.manager);
    const res = await Promise.allSettled(Array.from({ length: 20 }, () => createRequest(mgr, { title: "Concurrent create", taxYear: 2031, dueDate: "2032-01-01", items: [], assignees: [] })));
    expect(res.every((r) => r.status === "fulfilled")).toBe(true);
    const refs = (await withTenant(owner.db, { tenantId: A.tenantId }, (tx) => tx.execute(sql`select reference from requests where tax_year = 2031`))).rows.map((r) => (r as { reference: string }).reference);
    expect(new Set(refs).size).toBe(20);
    expect(refs.map((r) => Number(r.split("-")[2])).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("two reviewers deciding the same AI result at once: one decision, one validation job", async () => {
    const f = await createFileFixture(owner, A, "race.xlsx");
    const id = randomUUID(), runId = randomUUID(), jobId = randomUUID();
    await withTenant(owner.db, { tenantId: A.tenantId }, async (tx) => {
      await tx.execute(sql`insert into jobs (id, tenant_id, type, payload, status) values (${jobId}, ${A.tenantId}, 'x', '{}', 'succeeded')`);
      await tx.insert(agentRuns).values({ id: runId, tenantId: A.tenantId, jobId, agentName: "x", agentVersion: "1", event: "x", fileId: f.fileId, status: "succeeded" });
      await tx.insert(proposals).values({ id, tenantId: A.tenantId, runId, fileId: f.fileId, requestId: f.requestId, itemId: f.itemId, kind: "extraction", schemaKey: "trial_balance", title: "T", confidence: "0.9", payload: { schema: "trial_balance" } } as never);
    });
    const rev = await ctxFor(A.users.reviewer), mgr = await ctxFor(A.users.manager);
    const res = await settle(8, (i) => decideProposal(i % 2 ? rev : mgr, id, i % 4 === 3 ? { decision: "rejected", note: "wrong columns" } : { decision: "accepted" }));
    expect(res.ok).toBe(1); expect(res.raw).toEqual([]);
    const events = (await withTenant(owner.db, { tenantId: A.tenantId }, (tx) => tx.select({ p: jobs.payload }).from(jobs).where(eq(jobs.type, "proposal.accepted")))).filter((j) => (j.p as { proposalId: string }).proposalId === id);
    const [row] = await withTenant(owner.db, { tenantId: A.tenantId }, (tx) => tx.select({ s: proposals.status }).from(proposals).where(eq(proposals.id, id)));
    expect(events.length).toBe(row!.s === "accepted" ? 1 : 0);                      // a job exists only if the winning decision was "accept"
  });

  it("fifty comments at once are all stored and none fails", async () => {
    const { id, mgr } = await newRequest(); await publishRequest(mgr, id);
    const con = await ctxFor(A.users.contributor);
    const res = await settle(50, (i) => addComment(con, id, { body: `comment ${i}` }));
    expect(res.ok).toBe(50); expect(res.raw).toEqual([]);
    expect(await count(sql`select count(*) n from comments where request_id = ${id}`)).toBe(50);
  });
});
