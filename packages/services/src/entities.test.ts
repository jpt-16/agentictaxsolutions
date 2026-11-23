import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { ForbiddenError } from "@taxops/core";
import { agentRuns, assignments, connect, legalEntities, proposals, withTenant, type Connection } from "@taxops/db";
import { createFileFixture, createTestTenant, TEST_APP_URL, TEST_OWNER_URL, type FileFixture, type TestTenant } from "@taxops/db/src/testing";
import { ConflictError, decideProposal, getProposal, listAudit, loadSession, NotFoundError, setProposalEntity, type ServiceContext } from "./index";

const golden = JSON.parse(readFileSync(resolve(__dirname, "../../../schemas/fixtures/extraction_proposal.json"), "utf8"));
let owner: Connection, app: Connection;
let A: TestTenant, B: TestTenant;
const FR = randomUUID(), UK = randomUUID(), DE = randomUUID();

const ctxFor = async (t: TestTenant, userId: string): Promise<ServiceContext> => ({ db: app.db, session: (await loadSession(app.db, t.tenantId, userId))! });
const rev = () => ctxFor(A, A.users.reviewer);
const mgr = () => ctxFor(A, A.users.manager);
const aud = () => ctxFor(A, A.users.auditor);

/** A pending trial balance whose sheet text, uploader and assignments are under the test's control. */
async function tb(opts: { title?: string; fileName?: string; assign?: string[]; schemaKey?: string } = {}) {
  const f: FileFixture = await createFileFixture(owner, A, opts.fileName ?? "tb.xlsx");
  const runId = randomUUID(), id = randomUUID();
  const payload = { ...golden.proposal.payload, metadata: { entity_hint: "TB", ...(opts.title ? { title_text: opts.title } : {}) } };
  await withTenant(owner.db, { tenantId: A.tenantId }, async (tx) => {
    const jobId = randomUUID();
    await tx.execute(sql`insert into jobs (id, tenant_id, type, payload, status) values (${jobId}, ${A.tenantId}, 'file.uploaded', '{}', 'succeeded')`);
    await tx.insert(agentRuns).values({ id: runId, tenantId: A.tenantId, jobId, agentName: "extraction", agentVersion: "1.0.0", event: "file.uploaded", fileId: f.fileId, status: "succeeded", llmCalls: 0 });
    await tx.insert(proposals).values({ id, tenantId: A.tenantId, runId, fileId: f.fileId, requestId: f.requestId, itemId: f.itemId, kind: "extraction", schemaKey: opts.schemaKey ?? "trial_balance", title: "Trial balance", detail: "", payload, confidence: "0.980", severity: "info" });
    for (const entityId of opts.assign ?? []) await tx.insert(assignments).values({ tenantId: A.tenantId, requestId: f.requestId, assigneeType: "entity", entityId });
  });
  return { id, f };
}
const stored = (id: string) => withTenant(owner.db, { tenantId: A.tenantId }, async (tx) => (await tx.execute(sql`select entity_id, source from proposal_entities where proposal_id = ${id}`)).rows[0] as { entity_id: string; source: string } | undefined);

beforeAll(async () => {
  owner = connect(TEST_OWNER_URL, { max: 4 }); app = connect(TEST_APP_URL, { max: 8 });
  A = await createTestTenant(owner, "en"); B = await createTestTenant(owner, "eo");
  await withTenant(owner.db, { tenantId: A.tenantId }, async (tx) => {
    await tx.insert(legalEntities).values([
      { id: DE, tenantId: A.tenantId, code: "NWG", name: "Northwind GmbH", country: "DE", currency: "EUR" },
      { id: FR, tenantId: A.tenantId, code: "NWF", name: "Northwind France SAS", country: "FR", currency: "EUR" },
      { id: UK, tenantId: A.tenantId, code: "NWU", name: "Northwind UK Ltd.", country: "GB", currency: "GBP" },
    ]);
  });
});
afterAll(async () => { await owner.close(); await app.close(); });

describe("which entity a trial balance belongs to", () => {
  it("falls back to the uploader's entity, and accepting stores it with its source and records why", async () => {
    const { id, f } = await tb();
    const state = (await getProposal(await rev(), id)).entity!;
    expect(state.resolution).toMatchObject({ status: "suggested", suggestion: { source: "uploader", entity: { code: "TE1" } } });
    expect(state.chosen).toBeNull();
    await decideProposal(await rev(), id, { decision: "accepted" });
    expect(await stored(id)).toMatchObject({ source: "uploader" });
    const log = (await listAudit(await aud(), { requestRef: f.requestId })).rows.map((r) => r.action);
    expect(log).toContain("proposal.entity_confirmed");
    expect((await getProposal(await rev(), id)).entity!.chosen).toMatchObject({ source: "uploader", entity: { code: "TE1" } });
  });

  it("reads the entity from the sheet's title rows when it is one the request was sent to", async () => {
    const { id } = await tb({ title: "Northwind France SAS – Trial Balance", assign: [FR, UK] });
    const state = (await getProposal(await rev(), id)).entity!;
    expect(state.resolution).toMatchObject({ status: "suggested", suggestion: { source: "file", entity: { code: "NWF" } } });
    await decideProposal(await mgr(), id, { decision: "accepted" });
    expect(await stored(id)).toMatchObject({ entity_id: FR, source: "file" });
  });

  it("reads the entity from the file name too", async () => {
    const { id } = await tb({ fileName: "NWU_TB_Q4.xlsx", assign: [UK, DE] });
    expect((await getProposal(await rev(), id)).entity!.resolution.suggestion).toMatchObject({ source: "file", entity: { code: "NWU" } });
  });

  it("refuses to accept when the file names an entity the request was not sent to, until the reviewer chooses", async () => {
    const { id } = await tb({ title: "Northwind UK Ltd – TB", assign: [DE] });
    expect((await getProposal(await rev(), id)).entity!.resolution.status).toBe("conflict");
    await expect(decideProposal(await rev(), id, { decision: "accepted" })).rejects.toThrow(/Choose which entity/);
    expect((await getProposal(await rev(), id)).status).toBe("pending");
    expect(await stored(id)).toBeUndefined();
    await setProposalEntity(await rev(), id, DE);
    await decideProposal(await rev(), id, { decision: "accepted" });
    expect(await stored(id)).toMatchObject({ entity_id: DE, source: "reviewer" });
  });

  it("refuses to accept when there is no evidence at all", async () => {
    const { id } = await tb({ assign: [DE, FR] }); // uploader belongs to neither
    expect((await getProposal(await rev(), id)).entity!.resolution.status).toBe("unknown");
    await expect(decideProposal(await rev(), id, { decision: "accepted" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("lets a reviewer reject without choosing an entity", async () => {
    const { id } = await tb({ assign: [DE, FR] });
    await decideProposal(await rev(), id, { decision: "rejected", note: "wrong file" });
    expect((await getProposal(await rev(), id)).status).toBe("rejected");
  });

  it("lets the reviewer change their mind while pending, and records each change", async () => {
    const { id, f } = await tb({ assign: [DE, FR] });
    await setProposalEntity(await rev(), id, DE);
    await setProposalEntity(await mgr(), id, FR);
    expect(await stored(id)).toMatchObject({ entity_id: FR, source: "reviewer" });
    const sets = (await listAudit(await aud(), { requestRef: f.requestId })).rows.filter((r) => r.action === "proposal.entity_set");
    expect(sets).toHaveLength(2);
  });

  it("freezes the entity once the result is decided", async () => {
    const { id } = await tb();
    await decideProposal(await rev(), id, { decision: "accepted" });
    await expect(setProposalEntity(await rev(), id, FR)).rejects.toThrow(/already accepted/);
    // and the database refuses it even if the service were bypassed
    await expect(withTenant(app.db, { tenantId: A.tenantId, userId: A.users.reviewer }, (tx) => tx.execute(sql`update proposal_entities set entity_id = ${FR} where proposal_id = ${id}`))).rejects.toThrow();
  });

  it("only reviewers and managers may set it, and only to an entity of their own tenant", async () => {
    const { id } = await tb();
    for (const userId of [A.users.auditor, A.users.admin, A.users.contributor]) await expect(setProposalEntity(await ctxFor(A, userId), id, FR)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setProposalEntity(await rev(), id, B.entityId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(setProposalEntity(await rev(), id, "not-a-uuid")).rejects.toBeInstanceOf(NotFoundError);
    await expect(setProposalEntity(await ctxFor(B, B.users.reviewer), id, B.entityId)).rejects.toBeInstanceOf(NotFoundError);
    expect(await stored(id)).toBeUndefined();
  });

  it("does not apply to documents", async () => {
    const { id } = await tb({ schemaKey: "supporting_document" });
    expect((await getProposal(await rev(), id)).entity).toBeNull();
  });
});
