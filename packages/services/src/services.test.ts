import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { ForbiddenError, InvalidTransitionError } from "@taxops/core";
import { connect, withTenant, auditEvents, departments, legalEntities, users, requests, type Connection } from "@taxops/db";
import { createTestTenant, TEST_APP_URL, TEST_OWNER_URL, type TestTenant } from "@taxops/db/src/testing";
import {
  addComment, closeRequest, createRequest, getDashboard, getRequestDetail, listAudit, listRequests, loadSession,
  NotFoundError, publishRequest, reviewItem, submitItem, verifyAuditTrail, listDirectory,
  type ServiceContext,
} from "./index";

let owner: Connection;
let app: Connection;
let A: TestTenant;
let B: TestTenant;
let otherDept: string;
let otherEntity: string;
let contributor2: string;

const NOW = new Date("2026-03-01T12:00:00Z");

async function ctxFor(t: TestTenant, userId: string): Promise<ServiceContext> {
  const session = await loadSession(app.db, t.tenantId, userId);
  if (!session) throw new Error("no session");
  return { db: app.db, session, now: () => NOW };
}

const mgr = () => ctxFor(A, A.users.manager);
const rev = () => ctxFor(A, A.users.reviewer);
const con = () => ctxFor(A, A.users.contributor);
const con2 = () => ctxFor(A, contributor2);
const aud = () => ctxFor(A, A.users.auditor);

async function draft(opts: { items?: number; assignDept?: boolean; dueDate?: string; title?: string } = {}) {
  const m = await mgr();
  const n = opts.items ?? 2;
  return createRequest(m, {
    title: opts.title ?? "FY2025 trial balances",
    taxYear: 2025,
    dueDate: opts.dueDate ?? "2026-03-20",
    priority: "high",
    items: Array.from({ length: n }, (_, i) => ({ title: `Item ${i + 1}`, dataType: "trial_balance" as const })),
    assignees: opts.assignDept === false ? [] : [{ type: "department" as const, id: A.departmentId }],
  });
}
async function published(opts: Parameters<typeof draft>[0] = {}) {
  const r = await draft(opts);
  await publishRequest(await mgr(), r.id);
  return r;
}

beforeAll(async () => {
  owner = connect(TEST_OWNER_URL, { max: 4 });
  app = connect(TEST_APP_URL, { max: 10 });
  A = await createTestTenant(owner, "a");
  B = await createTestTenant(owner, "b");
  otherDept = randomUUID(); otherEntity = randomUUID(); contributor2 = randomUUID();
  await withTenant(owner.db, { tenantId: A.tenantId }, async (tx) => {
    await tx.insert(departments).values({ id: otherDept, tenantId: A.tenantId, name: "Other Dept", code: "OD" });
    await tx.insert(legalEntities).values({ id: otherEntity, tenantId: A.tenantId, name: "Other Entity", code: "OE", country: "DE", currency: "EUR" });
    await tx.insert(users).values({
      id: contributor2, tenantId: A.tenantId, email: `c2@${A.slug}.test`, name: "Dan Other", role: "contributor",
      departmentId: otherDept, entityId: otherEntity,
    });
  });
});
afterAll(async () => { await owner.close(); await app.close(); });

describe("authorization", () => {
  it("only managers can create requests", async () => {
    for (const c of [await con(), await rev(), await aud()]) {
      await expect(createRequest(c, { title: "Sneaky request", taxYear: 2025, dueDate: "2026-04-01" })).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("only audit roles can read the audit log", async () => {
    await expect(listAudit(await con())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listAudit(await rev())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listAudit(await aud())).resolves.toBeTruthy();
    await expect(verifyAuditTrail(await con())).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("contributors cannot see the directory; managers can", async () => {
    await expect(listDirectory(await con())).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listDirectory(await mgr())).users.length).toBeGreaterThan(3);
  });

  it("validates input", async () => {
    await expect(createRequest(await mgr(), { title: "x", taxYear: 1800, dueDate: "nope" })).rejects.toThrow();
  });
});

describe("visibility and scoping", () => {
  it("hides drafts from contributors and shows them after publishing", async () => {
    const r = await draft({ title: "Draft visibility test" });
    await expect(getRequestDetail(await con(), r.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listRequests(await con(), { q: "Draft visibility" })).rows).toHaveLength(0);
    expect((await listRequests(await mgr(), { q: "Draft visibility" })).rows).toHaveLength(1);
    await publishRequest(await mgr(), r.id);
    expect((await getRequestDetail(await con(), r.id)).reference).toBe(r.reference);
  });

  it("limits contributors to requests assigned to their department, entity or themselves", async () => {
    const r = await published({ title: "Dept-only scoping test" });
    await expect(getRequestDetail(await con2(), r.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listRequests(await con2(), { q: "Dept-only scoping" })).rows).toHaveLength(0);
    expect((await listRequests(await con(), { q: "Dept-only scoping" })).rows).toHaveLength(1);

    const m = await mgr();
    const byEntity = await createRequest(m, {
      title: "Entity-only assignment", taxYear: 2025, dueDate: "2026-05-01",
      items: [{ title: "Intercompany", dataType: "intercompany" }], assignees: [{ type: "entity", id: otherEntity }],
    });
    await publishRequest(m, byEntity.id);
    expect((await getRequestDetail(await con2(), byEntity.id)).title).toBe("Entity-only assignment");
    await expect(getRequestDetail(await con(), byEntity.id)).rejects.toBeInstanceOf(NotFoundError);

    const byUser = await createRequest(m, {
      title: "Direct user assignment", taxYear: 2025, dueDate: "2026-05-01",
      items: [{ title: "Narrative", dataType: "narrative" }], assignees: [{ type: "user", id: A.users.contributor }],
    });
    await publishRequest(m, byUser.id);
    expect((await getRequestDetail(await con(), byUser.id)).title).toBe("Direct user assignment");
    await expect(getRequestDetail(await con2(), byUser.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a contributor outside the assignment cannot submit against the item", async () => {
    const r = await published({ title: "Cannot poke other depts" });
    const detail = await getRequestDetail(await mgr(), r.id);
    await expect(submitItem(await con2(), detail.items[0]!.id, { note: "I should not be able to" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("isolates tenants completely", async () => {
    const r = await published({ title: "Tenant A secret" });
    const bMgr = await ctxFor(B, B.users.manager);
    await expect(getRequestDetail(bMgr, r.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listRequests(bMgr, { q: "Tenant A secret" })).rows).toHaveLength(0);
    await expect(publishRequest(bMgr, r.id)).rejects.toBeInstanceOf(NotFoundError);
    const bAudit = await listAudit(await ctxFor(B, B.users.auditor));
    expect(bAudit.rows.every((e) => e.tenantId === B.tenantId)).toBe(true);
  });
});

describe("workflow", () => {
  it("cannot publish without items or assignees", async () => {
    const noItems = await draft({ items: 0 });
    await expect(publishRequest(await mgr(), noItems.id)).rejects.toBeInstanceOf(InvalidTransitionError);
    const noAssignees = await draft({ assignDept: false });
    await expect(publishRequest(await mgr(), noAssignees.id)).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("runs the full lifecycle: submit → review → changes → resubmit → approve → close", async () => {
    const r = await published({ title: "Full lifecycle" });
    const status = async () => (await getRequestDetail(await mgr(), r.id)).status;
    const items = (await getRequestDetail(await mgr(), r.id)).items;
    expect(await status()).toBe("open");

    await submitItem(await con(), items[0]!.id, { note: "Uploaded TB for entity 1" });
    expect(await status()).toBe("in_progress");
    await submitItem(await con(), items[1]!.id, { note: "Uploaded TB for entity 2" });
    expect(await status()).toBe("in_review");

    await expect(reviewItem(await rev(), items[0]!.id, { decision: "changes_requested", rationale: "" })).rejects.toThrow();
    await reviewItem(await rev(), items[0]!.id, { decision: "changes_requested", rationale: "Missing the FX column" });
    expect(await status()).toBe("changes_requested");

    await submitItem(await con(), items[0]!.id, { note: "Added FX column" });
    expect(await status()).toBe("in_review");
    await reviewItem(await rev(), items[0]!.id, { decision: "approved" });
    expect(await status()).toBe("in_review");
    await reviewItem(await mgr(), items[1]!.id, { decision: "approved" });
    expect(await status()).toBe("approved");

    const detail = await getRequestDetail(await mgr(), r.id);
    expect(detail.items[0]!.submissions.map((s) => s.version)).toEqual([2, 1]);
    expect(detail.items[0]!.submissions[1]!.review?.decision).toBe("changes_requested");
    expect(detail.can.close).toBe(true);

    await expect(closeRequest(await con(), r.id)).rejects.toBeInstanceOf(ForbiddenError);
    await closeRequest(await mgr(), r.id);
    expect(await status()).toBe("closed");
    await expect(submitItem(await con(), items[0]!.id, { note: "too late" })).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("rejects illegal item transitions", async () => {
    const r = await published({ items: 1, title: "Illegal transitions" });
    const item = (await getRequestDetail(await mgr(), r.id)).items[0]!;
    await expect(reviewItem(await rev(), item.id, { decision: "approved" })).rejects.toBeInstanceOf(InvalidTransitionError);
    await submitItem(await con(), item.id, { note: "First submission" });
    await expect(submitItem(await con(), item.id, { note: "Second, while awaiting review" })).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("enforces segregation of duties when a submitter later gains a reviewer role", async () => {
    const r = await published({ items: 1, title: "SoD check" });
    const item = (await getRequestDetail(await mgr(), r.id)).items[0]!;
    await submitItem(await con(), item.id, { note: "My own work" });
    // The contributor is promoted to reviewer after submitting. They must still not approve their own work.
    await withTenant(owner.db, { tenantId: A.tenantId }, (tx) =>
      tx.update(users).set({ role: "tax_reviewer" }).where(eq(users.id, A.users.contributor)));
    try {
      const promoted = await con();
      expect(promoted.session.role).toBe("tax_reviewer");
      await expect(reviewItem(promoted, item.id, { decision: "approved" })).rejects.toThrow(/Segregation of duties/);
      const view = await getRequestDetail(promoted, r.id).catch(() => null);
      if (view) expect(view.items[0]!.can.review).toBe(false);
    } finally {
      await withTenant(owner.db, { tenantId: A.tenantId }, (tx) =>
        tx.update(users).set({ role: "contributor" }).where(eq(users.id, A.users.contributor)));
    }
  });

  it("serializes concurrent submissions of the same item", async () => {
    const r = await published({ items: 1, title: "Race condition" });
    const item = (await getRequestDetail(await mgr(), r.id)).items[0]!;
    const c = await con();
    const results = await Promise.allSettled([
      submitItem(c, item.id, { note: "attempt one" }),
      submitItem(c, item.id, { note: "attempt two" }),
      submitItem(c, item.id, { note: "attempt three" }),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const detail = await getRequestDetail(await mgr(), r.id);
    expect(detail.items[0]!.submissions).toHaveLength(1);
  });

  it("supports comments for anyone who can see the request, not for others", async () => {
    const r = await published({ title: "Comment thread" });
    await addComment(await con(), r.id, { body: "Do we need the 2024 comparatives too?" });
    await addComment(await mgr(), r.id, { body: "Yes please." });
    expect((await getRequestDetail(await mgr(), r.id)).comments).toHaveLength(2);
    await expect(addComment(await con2(), r.id, { body: "I should not see this" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(addComment(await aud(), r.id, { body: "read-only role" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("audit history", () => {
  it("records every action with actor, request link and a verifiable chain", async () => {
    const r = await published({ items: 1, title: "Audit coverage" });
    const item = (await getRequestDetail(await mgr(), r.id)).items[0]!;
    await submitItem(await con(), item.id, { note: "audit me" });
    await reviewItem(await rev(), item.id, { decision: "approved" });
    await closeRequest(await mgr(), r.id);

    const log = await listAudit(await aud(), { requestRef: r.id });
    const actions = log.rows.map((e) => e.action).reverse();
    expect(actions).toEqual([
      "request.created", "request.published", "item.submitted", "request.status_changed",
      "item.approved", "request.status_changed", "request.closed",
    ]);
    expect(actions[0]).toBe("request.created");
    expect(actions[1]).toBe("request.published");
    expect(actions).toContain("item.submitted");
    expect(actions).toContain("item.approved");
    expect(actions.at(-1)).toBe("request.closed");

    const created = log.rows.find((e) => e.action === "request.created")!;
    expect(created.actorLabel).toContain("Mia Manager");
    expect(created.actorId).toBe(A.users.manager);
    const approved = log.rows.find((e) => e.action === "item.approved")!;
    expect(approved.before).toMatchObject({ status: "submitted" });
    expect(approved.after).toMatchObject({ status: "approved" });

    expect(await verifyAuditTrail(await aud())).toMatchObject({ ok: true });
  });

  it("rolls the change back when the transaction fails, leaving no orphan audit event", async () => {
    const reqBefore = (await withTenant(owner.db, { tenantId: A.tenantId }, (tx) => tx.select().from(requests))).length;
    const auditBefore = (await listAudit(await aud())).total;
    // An assignee from ANOTHER tenant violates the composite FK mid-transaction.
    await expect(createRequest(await mgr(), {
      title: "Should fully roll back", taxYear: 2025, dueDate: "2026-06-01",
      items: [{ title: "An item", dataType: "other" }], assignees: [{ type: "entity", id: B.entityId }],
    })).rejects.toThrow();
    const reqAfter = (await withTenant(owner.db, { tenantId: A.tenantId }, (tx) => tx.select().from(requests))).length;
    expect(reqAfter).toBe(reqBefore);
    expect((await listAudit(await aud())).total).toBe(auditBefore);
  });

  it("filters the log", async () => {
    const onlyItems = await listAudit(await aud(), { actionPrefix: "item." });
    expect(onlyItems.rows.length).toBeGreaterThan(0);
    expect(onlyItems.rows.every((e) => e.action.startsWith("item."))).toBe(true);
    const search = await listAudit(await aud(), { q: "Mia Manager" });
    expect(search.rows.every((e) => /Mia Manager/i.test(e.actorLabel + e.summary))).toBe(true);
  });
});

describe("dashboard", () => {
  it("computes KPIs with an injectable clock and role-aware queues", async () => {
    const overdueReq = await published({ items: 1, title: "Dash overdue", dueDate: "2026-02-15" });
    const soon = await published({ items: 1, title: "Dash due soon", dueDate: "2026-03-05" });
    const m = await getDashboard(await mgr());
    expect(m.kpis.overdue).toBeGreaterThanOrEqual(1);
    expect(m.kpis.dueSoon).toBeGreaterThanOrEqual(1);
    expect(m.upcoming.some((u) => u.id === overdueReq.id && u.overdue)).toBe(true);

    // contributor: queue = things to submit; reviewer: queue = things to review
    const cDash = await getDashboard(await con());
    expect(cDash.queueKind).toBe("submit");
    expect(cDash.queue.length).toBeGreaterThan(0);
    const item = (await getRequestDetail(await mgr(), soon.id)).items[0]!;
    await submitItem(await con(), item.id, { note: "ready for review" });
    const rDash = await getDashboard(await rev());
    expect(rDash.queueKind).toBe("review");
    expect(rDash.queue.some((q) => q.itemId === item.id)).toBe(true);
    expect(rDash.kpis.awaitingReview).toBeGreaterThanOrEqual(1);

    // a contributor in another department sees none of department A's work
    const c2 = await getDashboard(await con2());
    const hiddenIds = [overdueReq.id, soon.id];
    expect(c2.upcoming.some((u) => hiddenIds.includes(u.id))).toBe(false);
    expect(c2.queue.some((q) => hiddenIds.includes(q.requestId))).toBe(false);
    expect((await getDashboard(await aud())).queueKind).toBeNull();
  });
});

describe("sessions", () => {
  it("reflects deactivation immediately", async () => {
    const id = randomUUID();
    await withTenant(owner.db, { tenantId: A.tenantId }, (tx) =>
      tx.insert(users).values({ id, tenantId: A.tenantId, email: `temp@${A.slug}.test`, name: "Temp", role: "contributor" }));
    expect(await loadSession(app.db, A.tenantId, id)).not.toBeNull();
    await withTenant(owner.db, { tenantId: A.tenantId }, (tx) => tx.update(users).set({ isActive: false }).where(eq(users.id, id)));
    expect(await loadSession(app.db, A.tenantId, id)).toBeNull();
    // and a user id from another tenant never resolves
    expect(await loadSession(app.db, B.tenantId, A.users.manager)).toBeNull();
  });
});
