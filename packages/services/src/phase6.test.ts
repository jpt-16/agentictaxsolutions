import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { agentRuns, auditEvents, connect, extractedRows, jobs, proposals, withTenant, type Connection } from "@taxops/db";
import { createFileFixture, createTestTenant, TEST_APP_URL, TEST_OWNER_URL, type FileFixture, type TestTenant } from "@taxops/db/src/testing";
import { databaseNowMs, addComment, createRequest, listNotifications, mentionedUsers, publishRequest, archiveTemplate, createTemplateFromRequest, getTemplate, listTemplates, approvedDataPack, csvOf, decideProposal, exportStatusReportCsv, loadSession, requestStatusReport, DATA_PACK_COLUMNS, type ServiceContext } from "./index";

const golden = JSON.parse(readFileSync(resolve(__dirname, "../../../schemas/fixtures/extraction_proposal.json"), "utf8"));
const docGolden = JSON.parse(readFileSync(resolve(__dirname, "../../../schemas/fixtures/document_proposal.json"), "utf8"));
let owner: Connection, app: Connection;
let A: TestTenant, B: TestTenant;
const ctxFor = async (t: TestTenant, userId: string): Promise<ServiceContext> => ({ db: app.db, session: (await loadSession(app.db, t.tenantId, userId))! });

async function addProposal(f: FileFixture, schemaKey: string, payload: unknown, over: Record<string, unknown> = {}, rows: Record<string, string>[] = []) {
  const id = randomUUID(), runId = randomUUID(), jobId = randomUUID();
  await withTenant(owner.db, { tenantId: A.tenantId }, async (tx) => {
    await tx.execute(sql`insert into jobs (id, tenant_id, type, payload, status) values (${jobId}, ${A.tenantId}, 'x', '{}', 'succeeded')`);
    await tx.insert(agentRuns).values({ id: runId, tenantId: A.tenantId, jobId, agentName: "x", agentVersion: "1", event: "x", fileId: f.fileId, status: "succeeded" });
    await tx.insert(proposals).values({ id, tenantId: A.tenantId, runId, fileId: f.fileId, requestId: f.requestId, itemId: f.itemId, kind: "extraction", schemaKey, title: "T", confidence: "0.9", severity: "info", payload, ...over } as never);
    let pos = 1;
    for (const values of rows) await tx.insert(extractedRows).values({ tenantId: A.tenantId, proposalId: id, position: pos++, sheet: "S", sourceRow: pos, values, cells: { debit: `C${pos}` } });
  });
  return id;
}

beforeAll(async () => {
  owner = connect(TEST_OWNER_URL, { max: 4 }); app = connect(TEST_APP_URL, { max: 8 });
  A = await createTestTenant(owner, "p6a"); B = await createTestTenant(owner, "p6b");
});
afterAll(async () => { await owner.close(); await app.close(); });

describe("reports and exports", () => {
  it("the approved data pack contains only accepted trial-balance rows, with lineage", async () => {
    const f = await createFileFixture(owner, A, "tb.xlsx");
    const when = new Date();
    await addProposal(f, "trial_balance", golden.proposal.payload, { status: "accepted", decidedBy: A.users.reviewer, decidedAt: when }, [
      { account_code: "1000", account_name: "Cash", debit: "100", credit: "0" }, { account_code: "=1+1", account_name: "+Evil", debit: "0", credit: "100" }]);
    await addProposal(f, "trial_balance", golden.proposal.payload, { status: "pending" }, [{ account_code: "9999", account_name: "Pending", debit: "1", credit: "0" }]); // not accepted
    await addProposal(f, "supporting_document", docGolden, { status: "accepted", decidedBy: A.users.reviewer, decidedAt: when });                                       // not data
    const pack = await approvedDataPack(await ctxFor(A, A.users.manager), f.requestId);
    expect(pack.rows.map((r) => r.account_code)).toEqual(["1000", "=1+1"]);
    expect(pack.rows[0]).toMatchObject({ debit: "100", credit: "0", accepted_by: expect.any(String), source_cells: expect.stringContaining("C") });
    const csv = csvOf(DATA_PACK_COLUMNS, pack.rows);
    expect(csv).toContain("'=1+1,'+Evil");        // spreadsheet formulas are neutralised
    expect(csv).not.toContain("9999");
  });

  it("exports are audited; another tenant cannot export this tenant's request", async () => {
    const f = await createFileFixture(owner, A, "tb2.xlsx");
    const ctx = await ctxFor(A, A.users.auditor);
    await approvedDataPack(ctx, f.requestId);
    await exportStatusReportCsv(ctx);
    const acts = await withTenant(owner.db, { tenantId: A.tenantId }, (tx) => tx.select({ a: auditEvents.action }).from(auditEvents).where(eq(auditEvents.entityType, "report")));
    expect(acts.map((x) => x.a)).toContain("report.exported");
    await expect(approvedDataPack(await ctxFor(B, B.users.manager), f.requestId)).rejects.toThrow(/not found/i);
  });

  it("the status report summarises counts and overdue work", async () => {
    await createFileFixture(owner, A, "tb3.xlsx");
    const r = await requestStatusReport(await ctxFor(A, A.users.manager));
    expect(r.summary.total).toBe(r.rows.length);
    expect(Object.values(r.summary.byStatus).reduce((a, b) => a + b, 0)).toBe(r.summary.total);
    const csv = await exportStatusReportCsv(await ctxFor(A, A.users.manager));
    expect(csv.split("\r\n")[0]).toBe("reference,title,tax_year,status,priority,due_date,days_left,overdue,items_total,items_approved,items_submitted,published_at,closed_at,cycle_days");
  });
});

describe("supporting documents", () => {
  it("accepting a document or a trial balance announces it to the agents, each tagged with its own schema", async () => {
    const f = await createFileFixture(owner, A, "tb4.xlsx");
    const doc = await addProposal(f, "supporting_document", docGolden);
    const tb = await addProposal(f, "trial_balance", golden.proposal.payload, {}, [{ account_code: "1000", account_name: "Cash", debit: "1", credit: "0" }]);
    const events = () => withTenant(owner.db, { tenantId: A.tenantId }, async (tx) => (await tx.select({ p: jobs.payload }).from(jobs).where(eq(jobs.type, "proposal.accepted"))).map((j) => j.p as { proposalId: string; schema: string }));
    const before = (await events()).length;
    const ctx = await ctxFor(A, A.users.reviewer);
    await decideProposal(ctx, doc, { decision: "accepted" });
    await decideProposal(ctx, tb, { decision: "accepted" });
    const added = (await events()).slice(before);
    expect(added.map((e) => [e.proposalId, e.schema]).sort()).toEqual([[doc, "supporting_document"], [tb, "trial_balance"]].sort());
  });

  it("a rejected result starts nothing", async () => {
    const f = await createFileFixture(owner, A, "tb5.xlsx");
    const doc = await addProposal(f, "supporting_document", docGolden);
    const count = () => withTenant(owner.db, { tenantId: A.tenantId }, async (tx) => (await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.type, "proposal.accepted"))).length);
    const before = await count();
    await decideProposal(await ctxFor(A, A.users.reviewer), doc, { decision: "rejected", note: "wrong document" });
    expect(await count()).toBe(before);
  });
});

describe("request templates", () => {
  it("keep what a request asks for, never who it goes to or when it is due", async () => {
    const f = await createFileFixture(owner, A, "tpl.xlsx");
    const mgr = await ctxFor(A, A.users.manager);
    const { id } = await createTemplateFromRequest(mgr, f.requestId, "  Quarterly provision pack ");
    const t = await getTemplate(mgr, id);
    expect(t.name).toBe("Quarterly provision pack");
    expect(t.items.length).toBeGreaterThan(0);
    expect(Object.keys(t.items[0]!).sort()).toEqual(["dataType", "description", "required", "title"]);
    expect(JSON.stringify(t)).not.toMatch(/dueDate|assign|status/i);
    expect((await listTemplates(mgr)).map((x) => x.name)).toContain("Quarterly provision pack");
  });

  it("can be archived (not deleted) and then disappear from the list", async () => {
    const f = await createFileFixture(owner, A, "tpl2.xlsx");
    const mgr = await ctxFor(A, A.users.manager);
    const { id } = await createTemplateFromRequest(mgr, f.requestId, "Archive me");
    await archiveTemplate(mgr, id);
    expect((await listTemplates(mgr)).map((x) => x.id)).not.toContain(id);
    await expect(getTemplate(mgr, id)).rejects.toThrow(/not found/i);
    await expect(archiveTemplate(mgr, id)).rejects.toThrow(/not found/i);
    const rows = await withTenant(owner.db, { tenantId: A.tenantId }, (tx) => tx.execute(sql`select archived_at from request_templates where id = ${id}`));
    expect(rows.rows.length).toBe(1); // still there for the audit trail
  });

  it("are isolated per tenant and writable only by a tax manager, in the database as well as the app", async () => {
    const f = await createFileFixture(owner, A, "tpl3.xlsx");
    const mgr = await ctxFor(A, A.users.manager);
    const { id } = await createTemplateFromRequest(mgr, f.requestId, "Tenant A only");
    await expect(getTemplate(await ctxFor(B, B.users.manager), id)).rejects.toThrow(/not found/i);
    expect((await listTemplates(await ctxFor(B, B.users.manager))).map((x) => x.id)).not.toContain(id);
    // Even code that skips the service layer is stopped by the database for a non-manager.
    await expect(withTenant(app.db, { tenantId: A.tenantId, userId: A.users.reviewer }, (tx) =>
      tx.execute(sql`insert into request_templates (tenant_id, name, items, created_by) values (${A.tenantId}, 'sneaky', '[{"title":"x"}]'::jsonb, ${A.users.reviewer})`))).rejects.toThrow();
    await expect(createTemplateFromRequest(mgr, f.requestId, "x")).rejects.toThrow(); // name too short
  });
});

describe("@mentions", () => {
  const people = [{ id: "1", name: "Dana Whitfield" }, { id: "2", name: "Dana" }, { id: "3", name: "Li Wei" }];
  it("match whole names only, longest first, and ignore email addresses", () => {
    expect(mentionedUsers("ping @Dana Whitfield please", people).map((p) => p.id)).toEqual(["1"]);
    expect(mentionedUsers("@dana and @LI WEI", people).map((p) => p.id).sort()).toEqual(["2", "3"]);
    expect(mentionedUsers("mail dana@Dana.com", people)).toEqual([]);
    expect(mentionedUsers("@Danaway is not Dana", people)).toEqual([]);
    expect(mentionedUsers("no mentions here", people)).toEqual([]);
  });

  it("notify only people who can already see the request", async () => {
    const mgr = await ctxFor(A, A.users.manager);
    const r = await createRequest(mgr, { title: "Mention flow", taxYear: 2025, dueDate: "2027-01-01", items: [{ title: "An item", dataType: "other" }], assignees: [{ type: "department", id: A.departmentId }] });
    const stranger = randomUUID(), dept = randomUUID();
    await withTenant(owner.db, { tenantId: A.tenantId }, async (tx) => {
      await tx.execute(sql`insert into departments (id, tenant_id, name, code) values (${dept}, ${A.tenantId}, 'Elsewhere', 'EW')`);
      await tx.execute(sql`insert into users (id, tenant_id, email, name, role, department_id) values (${stranger}, ${A.tenantId}, ${`st-${stranger.slice(0, 6)}@x.test`}, 'Sam Stranger', 'contributor', ${dept})`);
    });
    const nameOf = async (id: string) => (await withTenant(owner.db, { tenantId: A.tenantId }, (tx) => tx.execute(sql`select name from users where id = ${id}`))).rows[0]!.name as string;
    const [assigned, reviewer] = [await nameOf(A.users.contributor), await nameOf(A.users.reviewer)];
    const titles = async (id: string) => (await listNotifications(await ctxFor(A, id))).filter((n) => n.title.includes("mentioned you")).map((n) => n.title);

    // Draft: a contributor is not yet able to see it, so a mention must not reach them. A reviewer (tenant-wide access) is told.
    await addComment(mgr, r.id, { body: `Draft note for @${assigned}, @${reviewer} and @Sam Stranger` });
    expect(await titles(A.users.contributor)).toEqual([]);
    expect(await titles(A.users.reviewer)).toHaveLength(1);
    await publishRequest(mgr, r.id);
    await addComment(mgr, r.id, { body: `Published: @${assigned} and @Sam Stranger` });
    expect((await titles(A.users.contributor))).toHaveLength(1);         // assigned via department: now visible
    expect(await titles(stranger)).toEqual([]);                            // other department: never told
    await addComment(mgr, r.id, { body: `Talking to myself @${await nameOf(A.users.manager)}` });
    expect(await titles(A.users.manager)).toEqual([]);                     // no self-notification
  });
});

describe("review fixes", () => {
  it("the CSV export keeps negative numbers intact but still neutralises anything that could be a formula", () => {
    const csv = csvOf(["v"], [{ v: "-1200" }, { v: "+5.25" }, { v: "=1+1" }, { v: "-x" }, { v: "@SUM(A1)" }, { v: "-1+1" }]);
    expect(csv.split("\r\n").slice(1, 7)).toEqual(["-1200", "+5.25", "'=1+1", "'-x", "'@SUM(A1)", "'-1+1"]);
  });
  it("session timestamps come from the database clock", async () => {
    const t = await databaseNowMs(app.db);
    expect(Math.abs(t - Date.now())).toBeLessThan(10_000);
  });
});
