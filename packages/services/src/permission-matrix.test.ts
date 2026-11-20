/**
 * The authorization matrix. Every gated operation is invoked as EVERY role; the outcome must agree with the permission table in
 * @taxops/core. A new service function that forgets its permission check fails here. A second matrix tries every operation from a
 * different tenant against this tenant's objects and requires that nothing leaks or succeeds.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { can, ForbiddenError, ROLES, type Permission, type Role } from "@taxops/core";
import { agentRuns, assignments, connect, extractedRows, files, proposals, withTenant, type Connection } from "@taxops/db";
import { createFileFixture, createTestTenant, TEST_APP_URL, TEST_OWNER_URL, type FileFixture, type TestTenant } from "@taxops/db/src/testing";
import * as S from "./index";
import { MemoryStorage, EicarScanner, type FileDeps, type ServiceContext } from "./index";

const golden = JSON.parse(readFileSync(resolve(__dirname, "../../../schemas/fixtures/extraction_proposal.json"), "utf8"));
let owner: Connection, app: Connection;
let A: TestTenant, B: TestTenant;
const storage = new MemoryStorage();
const deps: FileDeps = { storage, scanner: new EicarScanner() };
const userOf = (t: TestTenant, role: Role) => ({ tax_manager: t.users.manager, tax_reviewer: t.users.reviewer, contributor: t.users.contributor, auditor: t.users.auditor, tenant_admin: t.users.admin })[role];
const ctxOf = async (t: TestTenant, role: Role): Promise<ServiceContext> => ({ db: app.db, session: (await S.loadSession(app.db, t.tenantId, userOf(t, role)))! });

interface World { f: FileFixture; draftId: string; extId: string; findingId: string; fileId: string; userToEdit: string }

/** A fresh set of objects in tenant A for every call, so one case can never influence another. */
async function world(): Promise<World> {
  const f = await createFileFixture(owner, A, "tb.xlsx");
  const draft = await S.createRequest(await ctxOf(A, "tax_manager"), { title: `Draft ${randomUUID().slice(0, 6)}`, taxYear: 2025, dueDate: "2027-01-01", items: [{ title: "An item", dataType: "other" }], assignees: [{ type: "department", id: A.departmentId }] });
  const mk = async (kind: "extraction" | "finding", extra: Record<string, unknown>) => {
    const id = randomUUID(), runId = randomUUID(), jobId = randomUUID();
    await withTenant(owner.db, { tenantId: A.tenantId }, async (tx) => {
      await tx.execute(sql`insert into jobs (id, tenant_id, type, payload, status) values (${jobId}, ${A.tenantId}, 'x', '{}', 'succeeded')`);
      await tx.insert(agentRuns).values({ id: runId, tenantId: A.tenantId, jobId, agentName: "x", agentVersion: "1", event: "x", fileId: f.fileId, status: "succeeded" });
      await tx.insert(proposals).values({ id, tenantId: A.tenantId, runId, fileId: f.fileId, requestId: f.requestId, itemId: f.itemId, kind, schemaKey: "trial_balance", title: "T", confidence: "0.9", severity: "error", ...extra } as never);
      if (kind === "extraction") await tx.insert(extractedRows).values({ tenantId: A.tenantId, proposalId: id, position: 1, sheet: "S", sourceRow: 2, values: {}, cells: {} });
    });
    return id;
  };
  const accepted = { status: "accepted", decidedBy: A.users.reviewer, decidedAt: new Date() };
  const ext = await mk("extraction", { payload: golden.proposal.payload });
  const acceptedExt = await mk("extraction", { payload: golden.proposal.payload, ...accepted });
  const finding = await mk("finding", { sourceProposalId: acceptedExt, ruleId: "tb_footing", ...accepted, payload: { schema: "trial_balance", sheet: "S", rule_id: "tb_footing", rule_name: "r", summary: "s", explanation: "e", explanation_source: "template", suggestion: "g", evidence: [], metrics: {}, dedupe: "S", source_proposal_id: acceptedExt } });
  await withTenant(owner.db, { tenantId: A.tenantId }, async (tx) => {
    await tx.insert(assignments).values({ tenantId: A.tenantId, requestId: f.requestId, assigneeType: "department", departmentId: A.departmentId });
    const [fl] = await tx.select({ id: files.id, key: files.storageKey }).from(files).where(sql`${files.id} = ${f.fileId}`);
    await storage.put(fl!.key, Buffer.from("a,b\n1,2\n")); // so a permitted download actually has bytes
  });
  await withTenant(owner.db, { tenantId: A.tenantId }, (tx) => tx.execute(sql`update files set sha256 = ${require("node:crypto").createHash("sha256").update("a,b\n1,2\n").digest("hex")}, original_name = 'tb.csv', content_type = 'text/csv' where id = ${f.fileId}`));
  return { f, draftId: draft.id, extId: ext, findingId: finding, fileId: f.fileId, userToEdit: A.users.reviewer };
}

type Op = { name: string; perm: Permission | null; run: (c: ServiceContext, w: World) => Promise<unknown> };
const MAP = { headerRow: 3, columns: { account_code: "A", debit: "C", credit: "D" } };
const newReq = { title: "Matrix request", taxYear: 2025, dueDate: "2027-01-01", items: [], assignees: [] };

const OPS: Op[] = [
  { name: "createRequest", perm: "request.create", run: (c) => S.createRequest(c, newReq) },
  { name: "updateDraftRequest", perm: "request.update", run: (c, w) => S.updateDraftRequest(c, w.draftId, { ...newReq, title: "Matrix edited" }) },
  { name: "publishRequest", perm: "request.publish", run: (c, w) => S.publishRequest(c, w.draftId) },
  { name: "closeRequest", perm: "request.close", run: (c, w) => S.closeRequest(c, w.f.requestId) },
  { name: "submitItem", perm: "item.submit", run: (c, w) => S.submitItem(c, w.f.itemId, { note: "matrix note" }) },
  { name: "submitWithFiles", perm: "item.submit", run: (c, w) => S.submitWithFiles(c, deps, w.f.itemId, { note: "matrix note" }, []) },
  { name: "reviewItem", perm: "item.review", run: (c, w) => S.reviewItem(c, w.f.itemId, { decision: "approved" }) },
  { name: "addComment", perm: "comment.create", run: (c, w) => S.addComment(c, w.f.requestId, { body: "hello" }) },
  { name: "listAudit", perm: "audit.read", run: (c) => S.listAudit(c) },
  { name: "exportAudit", perm: "audit.read", run: (c) => S.exportAudit(c) },
  { name: "verifyAuditTrail", perm: "audit.read", run: (c) => S.verifyAuditTrail(c) },
  { name: "listDirectory", perm: "user.read", run: (c) => S.listDirectory(c) },
  { name: "listProposals", perm: "proposal.read", run: (c) => S.listProposals(c) },
  { name: "getProposal", perm: "proposal.read", run: (c, w) => S.getProposal(c, w.extId) },
  { name: "decideProposal", perm: "proposal.review", run: (c, w) => S.decideProposal(c, w.extId, { decision: "accepted" }) },
  { name: "requestRemap", perm: "proposal.review", run: (c, w) => S.requestRemap(c, w.extId, MAP) },
  { name: "reprocessFile", perm: "proposal.review", run: (c, w) => S.reprocessFile(c, w.fileId) },
  { name: "requestChangesFromFinding", perm: "proposal.review", run: (c, w) => S.requestChangesFromFinding(c, w.findingId) },
  { name: "listRules", perm: "proposal.read", run: (c) => S.listRules(c) },
  { name: "updateRule", perm: "rules.manage", run: (c) => S.updateRule(c, "tb_footing", { enabled: true }) },
  { name: "getTenantSettings", perm: "tenant.admin", run: (c) => S.getTenantSettings(c) },
  { name: "updateTenantSettings", perm: "tenant.admin", run: (c) => S.updateTenantSettings(c, { aiExtractionEnabled: true }) },
  { name: "listUsers", perm: "tenant.admin", run: (c) => S.listUsers(c) },
  { name: "createUser", perm: "tenant.admin", run: (c) => S.createUser(c, { email: `m-${randomUUID().slice(0, 8)}@x.test`, name: "Matrix User", role: "contributor" }) },
  { name: "updateUser", perm: "tenant.admin", run: (c, w) => S.updateUser(c, w.userToEdit, { title: "Matrix" }) },
  { name: "downloadFile", perm: null, run: (c, w) => S.downloadFile(c, deps, w.fileId) },
  { name: "previewFile", perm: null, run: (c, w) => S.previewFile(c, deps, w.fileId) },
  { name: "getRequestDetail", perm: null, run: (c, w) => S.getRequestDetail(c, w.f.requestId) },
  { name: "listRequests", perm: null, run: (c) => S.listRequests(c) },
  { name: "getDashboard", perm: null, run: (c) => S.getDashboard(c) },
  { name: "listNotifications", perm: null, run: (c) => S.listNotifications(c) },
];

beforeAll(async () => {
  owner = connect(TEST_OWNER_URL, { max: 4 }); app = connect(TEST_APP_URL, { max: 8 });
  A = await createTestTenant(owner, "mxa"); B = await createTestTenant(owner, "mxb");
  await withTenant(owner.db, { tenantId: A.tenantId }, (tx) => tx.execute(sql`update tenants set ai_extraction_enabled = true`)); // remap/reprocess need AI on
});
afterAll(async () => { await owner.close(); await app.close(); });

describe("role × operation matrix (every gated operation, every role)", () => {
  const gated = OPS.filter((o) => o.perm !== null);
  for (const op of gated) {
    it(`${op.name} requires "${op.perm}"`, async () => {
      for (const role of ROLES) {
        const w = await world();
        const outcome = await op.run(await ctxOf(A, role), w).then(() => "ok" as const, (e: unknown) => e);
        const allowed = can(role, op.perm!);
        if (allowed) expect(outcome instanceof ForbiddenError, `${role} should be allowed to ${op.name} (got ${String(outcome)})`).toBe(false);
        else expect(outcome instanceof ForbiddenError, `${role} must NOT be allowed to ${op.name} (got ${outcome === "ok" ? "success" : (outcome as Error).name})`).toBe(true);
      }
    });
  }

  it("operations without a single permission still deny people who may not see the object (contributor outside the assignment)", async () => {
    const w = await world();
    const stranger = randomUUID();
    await withTenant(owner.db, { tenantId: A.tenantId }, async (tx) => tx.execute(sql`insert into users (id, tenant_id, email, name, role) values (${stranger}, ${A.tenantId}, ${`s-${stranger.slice(0, 6)}@x.test`}, 'Stranger', 'contributor')`));
    const ctx: ServiceContext = { db: app.db, session: (await S.loadSession(app.db, A.tenantId, stranger))! };
    for (const op of OPS.filter((o) => ["getRequestDetail", "downloadFile", "previewFile", "submitItem", "submitWithFiles", "addComment"].includes(o.name))) {
      const e = await op.run(ctx, w).then(() => null, (x) => x);
      expect(e, `${op.name} must refuse an unassigned contributor`).toBeInstanceOf(Error);
      expect(["NotFoundError", "ForbiddenError"]).toContain((e as Error).name);
    }
  });
});

describe("cross-tenant matrix (tenant B's people against tenant A's objects)", () => {
  const targeted = OPS.filter((o) => !["createRequest", "listAudit", "exportAudit", "verifyAuditTrail", "listDirectory", "listProposals", "listRules", "updateRule", "getTenantSettings", "updateTenantSettings", "listUsers", "createUser", "listRequests", "getDashboard", "listNotifications"].includes(o.name));
  for (const op of targeted) {
    it(`${op.name} cannot reach another tenant's objects, whatever the role`, async () => {
      const w = await world();
      for (const role of ROLES) {
        const e = await op.run(await ctxOf(B, role), w).then(() => "succeeded", (x: Error) => x);
        expect(e, `${role} in tenant B must not be able to ${op.name} on tenant A's data`).not.toBe("succeeded");
        expect(["NotFoundError", "ForbiddenError", "InvalidTransitionError"], `${role}/${op.name}: ${(e as Error).name}: ${(e as Error).message}`).toContain((e as Error).name);
      }
    });
  }

  it("list-style operations only ever return the caller's own tenant's rows", async () => {
    await world();
    const bLists = await Promise.all((["tax_manager", "auditor", "tax_reviewer"] as const).map(async (r) => ({
      requests: (await S.listRequests(await ctxOf(B, r))).rows.map((x) => x.reference),
      props: r === "tax_manager" || r === "tax_reviewer" || r === "auditor" ? (await S.listProposals(await ctxOf(B, r), { status: "all" })).rows.length : 0,
      audit: r === "auditor" ? (await S.listAudit(await ctxOf(B, r))).rows.every((e) => e.tenantId === B.tenantId) : true,
    })));
    for (const l of bLists) { expect(l.requests).toEqual([]); expect(l.props).toBe(0); expect(l.audit).toBe(true); }
    expect((await S.exportAudit(await ctxOf(B, "auditor"))).events.every((e) => !String(e.summary).includes("Matrix"))).toBe(true);
    expect((await S.listUsers(await ctxOf(B, "tenant_admin"))).users.every((u) => !u.email.includes(A.slug))).toBe(true);
  });
});
