import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { ForbiddenError, InvalidTransitionError } from "@taxops/core";
import { agentRuns, assignments, connect, extractedRows, proposals, withTenant, type Connection } from "@taxops/db";
import { createFileFixture, createTestTenant, TEST_APP_URL, TEST_OWNER_URL, type FileFixture, type TestTenant } from "@taxops/db/src/testing";
import {
  decideProposal, getProposal, getRequestDetail, listAudit, listProposals, loadSession, NotFoundError, pendingProposalCount, verifyAuditTrail,
  pendingWorkForFile, reprocessFile, requestRemap,
  type ServiceContext,
} from "./index";

const golden = JSON.parse(readFileSync(resolve(__dirname, "../../../schemas/fixtures/extraction_proposal.json"), "utf8"));
let owner: Connection, app: Connection;
let A: TestTenant, B: TestTenant;

const ctxFor = async (t: TestTenant, userId: string): Promise<ServiceContext> => ({ db: app.db, session: (await loadSession(app.db, t.tenantId, userId))! });
const rev = () => ctxFor(A, A.users.reviewer);
const mgr = () => ctxFor(A, A.users.manager);
const con = () => ctxFor(A, A.users.contributor);
const aud = () => ctxFor(A, A.users.auditor);
const adm = () => ctxFor(A, A.users.admin);

/** Inserts an agent run + proposal + rows exactly as agent_save_results would (via the owner, as test fixture). */
async function seedProposal(t: TestTenant, f: FileFixture, opts: { payload?: unknown; rows?: number; title?: string } = {}) {
  const runId = randomUUID(), proposalId = randomUUID();
  await withTenant(owner.db, { tenantId: t.tenantId }, async (tx) => {
    const jobId = randomUUID();
    await tx.execute(sql`insert into jobs (id, tenant_id, type, payload, status) values (${jobId}, ${t.tenantId}, 'file.uploaded', '{}', 'succeeded')`);
    await tx.insert(agentRuns).values({ id: runId, tenantId: t.tenantId, jobId, agentName: "extraction", agentVersion: "1.0.0", event: "file.uploaded", fileId: f.fileId, status: "succeeded", llmCalls: 0 });
    await tx.insert(proposals).values({
      id: proposalId, tenantId: t.tenantId, runId, fileId: f.fileId, requestId: f.requestId, itemId: f.itemId, kind: "extraction", schemaKey: "trial_balance",
      title: opts.title ?? "Trial balance – NWU – GBP", detail: "6 accounts", payload: (opts.payload ?? golden.proposal.payload) as object, confidence: "0.980", severity: "info",
    });
    const n = opts.rows ?? 6;
    if (n) await tx.insert(extractedRows).values(Array.from({ length: n }, (_, i) => ({
      tenantId: t.tenantId, proposalId, position: i + 1, sheet: "NWU – GBP", sourceRow: i + 4,
      values: { account_code: `${1000 + i}`, account_name: `Acct ${i}`, debit: "10", credit: "0" }, cells: { debit: `C${i + 4}` }, issues: i === 2 ? ["Both debit and credit are populated."] : [],
    })));
  });
  return proposalId;
}
async function fresh(opts: Parameters<typeof seedProposal>[2] = {}) {
  const f = await createFileFixture(owner, A);
  return { f, id: await seedProposal(A, f, opts) };
}

beforeAll(async () => {
  owner = connect(TEST_OWNER_URL, { max: 4 }); app = connect(TEST_APP_URL, { max: 8 });
  A = await createTestTenant(owner, "pa"); B = await createTestTenant(owner, "pb");
  await withTenant(owner.db, { tenantId: A.tenantId }, (tx) => tx.execute(sql`update tenants set ai_extraction_enabled = true`)); // remap/reprocess need AI on
});
afterAll(async () => { await owner.close(); await app.close(); });

describe("who can see and decide AI output", () => {
  it("contributors see nothing; reviewers, managers, auditors and admins can read; only reviewers/managers can decide", async () => {
    const { id } = await fresh();
    await expect(listProposals(await con())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getProposal(await con(), id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await pendingProposalCount(await con())).toBe(0);
    for (const c of [await rev(), await mgr(), await aud(), await adm()]) expect((await getProposal(c, id)).id).toBe(id);
    for (const c of [await aud(), await adm(), await con()]) await expect(decideProposal(c, id, { decision: "accepted" })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await getProposal(await aud(), id)).can.decide).toBe(false);
    expect((await getProposal(await rev(), id)).can.decide).toBe(true);
  });

  it("is invisible across tenants", async () => {
    const { id } = await fresh();
    const bRev = await ctxFor(B, B.users.reviewer);
    await expect(getProposal(bRev, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(decideProposal(bRev, id, { decision: "accepted" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await listProposals(bRev, { status: "all" })).rows.some((r) => r.id === id)).toBe(false);
    expect((await getProposal(await rev(), id)).status).toBe("pending");
  });
});

describe("reading", () => {
  it("returns the parsed payload, source context and a page of lineage rows", async () => {
    const { id, f } = await fresh({ rows: 6 });
    const p = await getProposal(await rev(), id, { rowLimit: 4 });
    expect(p.payload?.stats.row_count).toBe(6);
    expect(p.payload?.columns.debit).toEqual({ letter: "C", header: "Debit" });
    expect(p.rows).toHaveLength(4); expect(p.totalRows).toBe(6);
    expect(p.rows[0]).toMatchObject({ position: 1, sourceRow: 4, cells: { debit: "C4" } });
    expect(p.rows[2]!.issues).toEqual(["Both debit and credit are populated."]);
    expect((await getProposal(await rev(), id, { rowOffset: 4, rowLimit: 4 })).rows).toHaveLength(2);
    expect(p.request.id).toBe(f.requestId); expect(p.file.name).toBe("tb.xlsx"); expect(p.submission).toEqual({ version: 1, by: "Cat Contributor" });
    expect(p.run).toMatchObject({ agent: "extraction", version: "1.0.0", llmCalls: 0 });
    expect(p.confidence).toBeCloseTo(0.98);
  });

  it("does not crash on a payload that violates the contract; it is surfaced as unreadable", async () => {
    const { id } = await fresh({ payload: { schema: "trial_balance", garbage: true } });
    const p = await getProposal(await rev(), id);
    expect(p.payload).toBeNull();
    expect(p.can.decide).toBe(true); // a human can still reject it
  });

  it("lists by status with counts", async () => {
    const { id } = await fresh({ title: "Listing test TB" });
    const pending = await listProposals(await rev(), { status: "pending" });
    expect(pending.rows.find((r) => r.id === id)).toMatchObject({ title: "Listing test TB", rowCount: 6, status: "pending", fileName: "tb.xlsx" });
    expect(await pendingProposalCount(await rev())).toBe(pending.total);
    await decideProposal(await rev(), id, { decision: "accepted" });
    expect((await listProposals(await rev(), { status: "pending" })).rows.some((r) => r.id === id)).toBe(false);
    expect((await listProposals(await rev(), { status: "accepted" })).rows.some((r) => r.id === id)).toBe(true);
  });
});

describe("deciding", () => {
  it("records who decided, when and why, and writes an audit event the chain still verifies", async () => {
    const { id, f } = await fresh();
    await decideProposal(await rev(), id, { decision: "accepted" });
    const p = await getProposal(await rev(), id);
    expect(p).toMatchObject({ status: "accepted", decidedByName: "Rob Reviewer", can: { decide: false } });
    expect(p.decidedAt).toBeInstanceOf(Date);
    const ev = (await listAudit(await aud(), { requestRef: f.requestId })).rows.find((e) => e.action === "proposal.accepted")!;
    expect(ev.actorId).toBe(A.users.reviewer);
    expect(ev.before).toMatchObject({ status: "pending" }); expect(ev.after).toMatchObject({ status: "accepted" });
    expect(await verifyAuditTrail(await aud())).toMatchObject({ ok: true });
  });

  it("requires a reason to reject; the rejection and reason are kept", async () => {
    const { id } = await fresh();
    await expect(decideProposal(await rev(), id, { decision: "rejected", note: "" })).rejects.toThrow();
    await decideProposal(await mgr(), id, { decision: "rejected", note: "Credit and debit columns are swapped" });
    expect(await getProposal(await rev(), id)).toMatchObject({ status: "rejected", decisionNote: "Credit and debit columns are swapped" });
  });

  it("decisions are final", async () => {
    const { id } = await fresh();
    await decideProposal(await rev(), id, { decision: "accepted" });
    await expect(decideProposal(await mgr(), id, { decision: "rejected", note: "changed my mind" })).rejects.toBeInstanceOf(InvalidTransitionError);
    expect((await getProposal(await rev(), id)).status).toBe("accepted");
  });

  it("lets exactly one of two simultaneous reviewers win", async () => {
    const { id, f } = await fresh();
    const [a, b] = await Promise.allSettled([decideProposal(await rev(), id, { decision: "accepted" }), decideProposal(await mgr(), id, { decision: "rejected", note: "disagree" })]);
    expect([a, b].filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const decisions = (await listAudit(await aud(), { requestRef: f.requestId })).rows.filter((e) => e.action.startsWith("proposal.") && e.action !== "proposal.created" && !e.action.startsWith("proposal.entity_"));
    expect(decisions).toHaveLength(1);
  });
});

describe("AI status on the request page", () => {
  it("shows reviewers where each file stands; contributors get no AI information", async () => {
    const queued = await createFileFixture(owner, A, "queued.xlsx");
    const { f } = await fresh();
    // The contributor's department is assigned, so they can open the request page (but must not see any AI information).
    await withTenant(owner.db, { tenantId: A.tenantId }, (tx) => tx.insert(assignments).values({ tenantId: A.tenantId, requestId: f.requestId, assigneeType: "department", departmentId: A.departmentId }));
    const ext = async (c: ServiceContext, reqId: string) => (await getRequestDetail(c, reqId)).items[0]!.submissions[0]!.files[0]!.extraction;
    expect(await ext(await rev(), queued.requestId)).toMatchObject({ state: "queued" });
    expect(await ext(await rev(), f.requestId)).toMatchObject({ state: "review", pending: 1 });
    expect(await ext(await con(), f.requestId)).toBeNull();
    const [p] = (await listProposals(await rev(), { requestId: f.requestId })).rows;
    await decideProposal(await rev(), p!.id, { decision: "accepted" });
    expect(await ext(await rev(), f.requestId)).toMatchObject({ state: "accepted", accepted: 1 });
  });
});

describe("correcting a mapping and re-processing", () => {
  const MAP = { headerRow: 4, columns: { account_code: "a", account_name: "B", debit: "C", credit: "D" } };
  const jobsOfType = async (fileId: string, type: string) =>
    (await withTenant(owner.db, { tenantId: A.tenantId }, (tx) => tx.execute(sql`select payload from jobs where type = ${type} and payload->>'fileId' = ${fileId}`))).rows as any[];

  it("queues a re-extraction with the reviewer's mapping and audits what changed", async () => {
    const { id, f } = await fresh();
    await requestRemap(await rev(), id, MAP);
    const [job] = await jobsOfType(f.fileId, "extraction.remap");
    expect(job.payload).toMatchObject({ fileId: f.fileId, requestId: f.requestId, itemId: f.itemId, sheet: "NWU – GBP", headerRow: 4, kind: "xlsx", requestedBy: A.users.reviewer,
      columns: { account_code: "A", account_name: "B", debit: "C", credit: "D" } }); // letters normalised to upper case
    const ev = (await listAudit(await aud(), { requestRef: f.requestId })).rows.find((e) => e.action === "proposal.remap_requested")!;
    expect(ev.before).toMatchObject({ headerRow: 3 }); expect(ev.after).toMatchObject({ headerRow: 4 });
    expect(await pendingWorkForFile(await rev(), f.fileId)).toBe(1);
    expect(await pendingWorkForFile(await con(), f.fileId)).toBe(0);
  });

  it("is limited to reviewers/managers, valid mappings, and results still awaiting review", async () => {
    const { id } = await fresh();
    for (const c of [await con(), await aud(), await adm()]) await expect(requestRemap(c, id, MAP)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requestRemap(await rev(), id, { headerRow: 1, columns: { account_code: "A" } })).rejects.toThrow();
    await expect(requestRemap(await ctxFor(B, B.users.reviewer), id, MAP)).rejects.toBeInstanceOf(NotFoundError);
    await decideProposal(await rev(), id, { decision: "accepted" });
    await expect(requestRemap(await rev(), id, MAP)).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("re-processes spreadsheets only, for authorized roles, within the tenant", async () => {
    const sheet = await createFileFixture(owner, A, "again.xlsx");
    await reprocessFile(await mgr(), sheet.fileId);
    expect((await jobsOfType(sheet.fileId, "file.uploaded"))[0].payload).toMatchObject({ fileId: sheet.fileId, requestId: sheet.requestId, itemId: sheet.itemId, kind: "xlsx" });
    expect((await listAudit(await aud(), { requestRef: sheet.requestId })).rows.some((e) => e.action === "file.reprocess_requested")).toBe(true);
    await expect(reprocessFile(await con(), sheet.fileId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reprocessFile(await ctxFor(B, B.users.manager), sheet.fileId)).rejects.toBeInstanceOf(NotFoundError);
    const pdf = await createFileFixture(owner, A, "memo.pdf");
    await expect(reprocessFile(await mgr(), pdf.fileId)).rejects.toBeInstanceOf(InvalidTransitionError);
  });
});

describe("audit #6: the AI switch governs reviewer-directed re-extraction too", () => {
  it("refuses remap and re-process while the tenant has AI extraction off, and allows them again when on", async () => {
    const { id, f } = await fresh();
    const setAi = (on: boolean) => withTenant(owner.db, { tenantId: A.tenantId }, (tx) => tx.execute(sql`update tenants set ai_extraction_enabled = ${on}`));
    await setAi(false);
    try {
      await expect(requestRemap(await rev(), id, { headerRow: 3, columns: { account_code: "A", debit: "C", credit: "D" } })).rejects.toThrow(/switched off/);
      await expect(reprocessFile(await mgr(), f.fileId)).rejects.toThrow(/switched off/);
      const jobs = (await withTenant(owner.db, { tenantId: A.tenantId }, (tx) => tx.execute(sql`select 1 from jobs where payload->>'fileId' = ${f.fileId}`))).rows;
      expect(jobs).toHaveLength(0);
    } finally { await setAi(true); }
    await requestRemap(await rev(), id, { headerRow: 3, columns: { account_code: "A", debit: "C", credit: "D" } });
  });
});
