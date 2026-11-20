import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { ForbiddenError, InvalidTransitionError } from "@taxops/core";
import { agentRuns, assignments, connect, proposals, withTenant, type Connection } from "@taxops/db";
import { createFileFixture, createTestTenant, TEST_APP_URL, TEST_OWNER_URL, type FileFixture, type TestTenant } from "@taxops/db/src/testing";
import {
  decideProposal, getProposal, getRequestDetail, listAudit, listProposals, listRules, loadSession, NotFoundError, requestChangesFromFinding, updateRule,
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

async function insertProposal(t: TestTenant, f: FileFixture, kind: "extraction" | "finding", extra: Record<string, unknown> = {}) {
  const id = randomUUID(), runId = randomUUID(), jobId = randomUUID();
  await withTenant(owner.db, { tenantId: t.tenantId }, async (tx) => {
    await tx.execute(sql`insert into jobs (id, tenant_id, type, payload, status) values (${jobId}, ${t.tenantId}, 'x', '{}', 'succeeded')`);
    await tx.insert(agentRuns).values({ id: runId, tenantId: t.tenantId, jobId, agentName: kind === "finding" ? "validation" : "extraction", agentVersion: "1", event: "x", fileId: f.fileId, status: "succeeded" });
    await tx.insert(proposals).values({
      id, tenantId: t.tenantId, runId, fileId: f.fileId, requestId: f.requestId, itemId: f.itemId, kind, schemaKey: "trial_balance",
      title: kind === "finding" ? "Debits and credits differ by 25" : "Trial balance – S", payload: kind === "extraction" ? golden.proposal.payload : {}, confidence: "0.9",
      severity: kind === "finding" ? "error" : "info", ...extra,
    } as never);
  });
  return id;
}
const FINDING_PAYLOAD = (src: string) => ({
  schema: "trial_balance", sheet: "S", rule_id: "tb_footing", rule_name: "Debits equal credits", summary: "Debits exceed credits by 25.", explanation: "The trial balance does not foot.",
  explanation_source: "template", suggestion: "Look for a one-sided posting.", evidence: [{ row: 5, sheet: "S", cells: ["C5"], note: "equals the gap" }], metrics: { difference: "25" }, dedupe: "S", source_proposal_id: src,
});
const jobsFor = async (fileId: string) => (await withTenant(owner.db, { tenantId: A.tenantId }, (tx) => tx.execute(sql`select type, payload from jobs where payload->>'fileId' = ${fileId}`))).rows as any[];

beforeAll(async () => {
  owner = connect(TEST_OWNER_URL, { max: 4 }); app = connect(TEST_APP_URL, { max: 8 });
  A = await createTestTenant(owner, "xa"); B = await createTestTenant(owner, "xb");
});
afterAll(async () => { await owner.close(); await app.close(); });

describe("accepting an extraction triggers validation", () => {
  it("enqueues exactly one proposal.accepted job, in the decision's transaction, only for accepted extractions", async () => {
    const f = await createFileFixture(owner, A);
    const ext = await insertProposal(A, f, "extraction");
    await decideProposal(await rev(), ext, { decision: "accepted" });
    const jobs = await jobsFor(f.fileId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ type: "proposal.accepted", payload: { proposalId: ext, fileId: f.fileId, requestId: f.requestId, itemId: f.itemId, schema: "trial_balance" } });

    const f2 = await createFileFixture(owner, A);
    await decideProposal(await rev(), await insertProposal(A, f2, "extraction"), { decision: "rejected", note: "bad mapping" });
    expect(await jobsFor(f2.fileId)).toHaveLength(0);
    const f3 = await createFileFixture(owner, A);
    const e3 = await insertProposal(A, f3, "extraction");
    const fin = await insertProposal(A, f3, "finding", { sourceProposalId: e3, ruleId: "tb_footing", payload: FINDING_PAYLOAD(e3) });
    await decideProposal(await rev(), fin, { decision: "accepted" });
    expect(await jobsFor(f3.fileId)).toHaveLength(0); // deciding a finding never re-triggers validation
  });
});

describe("findings", () => {
  async function withFinding() {
    const f = await createFileFixture(owner, A);
    const ext = await insertProposal(A, f, "extraction", { status: "accepted", decidedBy: A.users.reviewer, decidedAt: new Date() });
    const fin = await insertProposal(A, f, "finding", { sourceProposalId: ext, ruleId: "tb_footing", payload: FINDING_PAYLOAD(ext) });
    return { f, ext, fin };
  }

  it("are listed separately, parsed with their evidence, and linked to their source", async () => {
    const { ext, fin } = await withFinding();
    const only = await listProposals(await rev(), { kind: "finding", status: "pending" });
    expect(only.rows.every((r) => r.kind === "finding")).toBe(true);
    expect(only.rows.find((r) => r.id === fin)).toMatchObject({ ruleId: "tb_footing", severity: "error" });
    const d = await getProposal(await rev(), fin);
    expect(d.finding).toMatchObject({ rule_id: "tb_footing", explanation_source: "template" });
    expect(d.finding!.evidence[0]).toEqual({ row: 5, sheet: "S", cells: ["C5"], note: "equals the gap" });
    expect(d.source).toMatchObject({ id: ext }); expect(d.payload).toBeNull();
    const parent = await getProposal(await rev(), ext);
    expect(parent.findings).toEqual([expect.objectContaining({ id: fin, severity: "error", status: "pending", ruleId: "tb_footing" })]);
  });

  it("are confirmed or dismissed (final, reason to dismiss) and audited with finding wording", async () => {
    const { f, fin } = await withFinding();
    await expect(decideProposal(await rev(), fin, { decision: "rejected", note: "" })).rejects.toThrow();
    await decideProposal(await mgr(), fin, { decision: "accepted" });
    const ev = (await listAudit(await aud(), { requestRef: f.requestId })).rows.find((e) => e.action === "proposal.accepted")!;
    expect(ev.summary).toContain("Confirmed finding");
    await expect(decideProposal(await mgr(), fin, { decision: "rejected", note: "changed my mind" })).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("can be sent back to the contributor only after confirmation, through the normal review path", async () => {
    const { f, fin } = await withFinding();
    await expect(requestChangesFromFinding(await rev(), fin)).rejects.toBeInstanceOf(InvalidTransitionError); // still pending
    await decideProposal(await rev(), fin, { decision: "accepted" });
    expect((await getProposal(await rev(), fin)).can.sendBack).toBe(true);
    await expect(requestChangesFromFinding(await con(), fin)).rejects.toBeInstanceOf(ForbiddenError);
    await requestChangesFromFinding(await rev(), fin);
    await withTenant(owner.db, { tenantId: A.tenantId }, (tx) => tx.insert(assignments).values({ tenantId: A.tenantId, requestId: f.requestId, assigneeType: "department", departmentId: A.departmentId }));
    const item = (await getRequestDetail(await rev(), f.requestId)).items[0]!;
    expect(item.status).toBe("changes_requested");
    expect(item.submissions[0]!.review).toMatchObject({ decision: "changes_requested", rationale: expect.stringContaining("Validation finding: Debits and credits differ by 25") });
    expect((await getProposal(await rev(), fin)).can.sendBack).toBe(false); // item is no longer awaiting review
  });

  it("summarize on the request page for reviewers only, and are tenant-isolated", async () => {
    const { f, fin } = await withFinding();
    const v = (await getRequestDetail(await mgr(), f.requestId)).validation!;
    expect(v).toMatchObject({ open: 1, confirmed: 0, openErrors: 1 });
    await decideProposal(await mgr(), fin, { decision: "rejected", note: "False alarm: known timing" });
    expect((await getRequestDetail(await mgr(), f.requestId)).validation).toMatchObject({ open: 0, dismissed: 1, openErrors: 0 });
    await withTenant(owner.db, { tenantId: A.tenantId }, (tx) => tx.insert(assignments).values({ tenantId: A.tenantId, requestId: f.requestId, assigneeType: "department", departmentId: A.departmentId }));
    expect((await getRequestDetail(await con(), f.requestId)).validation).toBeNull();
    await expect(getProposal(await ctxFor(B, B.users.reviewer), fin)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("validation rule settings", () => {
  it("lists the catalog with defaults, and applies tenant changes with an audit trail", async () => {
    const before = (await listRules(await rev())).find((r) => r.id === "tb_footing")!;
    expect(before).toMatchObject({ enabled: true, customized: false, params: { tolerance: "0" } });
    await updateRule(await mgr(), "tb_footing", { enabled: true, params: { tolerance: "2.50" } });
    await updateRule(await adm(), "tb_both_sides", { enabled: false });
    const rules = await listRules(await aud());
    expect(rules.find((r) => r.id === "tb_footing")).toMatchObject({ enabled: true, customized: true, params: { tolerance: "2.50" } });
    expect(rules.find((r) => r.id === "tb_both_sides")).toMatchObject({ enabled: false });
    const ev = (await listAudit(await aud())).rows.filter((e) => e.action === "rule.updated");
    expect(ev.map((e) => e.summary).join("|")).toMatch(/Disabled validation rule "One side per account"/);
    expect(ev.find((e) => e.summary.includes("tolerance=2.50"))?.before).toMatchObject({ enabled: true });
    // other tenants are unaffected
    expect((await listRules(await ctxFor(B, B.users.manager))).find((r) => r.id === "tb_both_sides")!.enabled).toBe(true);
  });

  it("is restricted to managers and admins, validates input, and rejects unknown rules", async () => {
    for (const c of [await rev(), await con(), await aud()]) await expect(updateRule(c, "tb_footing", { enabled: false })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listRules(await con())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateRule(await mgr(), "tb_footing", { enabled: true, params: { tolerance: "-5" } })).rejects.toThrow();
    await expect(updateRule(await mgr(), "tb_footing", { enabled: true, params: { evil: "1" } })).rejects.toThrow();
    await expect(updateRule(await mgr(), "no_such_rule", { enabled: true })).rejects.toBeInstanceOf(NotFoundError);
  });
});
