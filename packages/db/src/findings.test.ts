import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { connect, withTenant, type Connection } from "./client";
import * as s from "./schema";
import { createFileFixture, createFileInRequest, createTestTenant, TEST_APP_URL, TEST_OWNER_URL, TEST_WORKER_URL, type FileFixture, type TestTenant } from "./testing";

let owner: Connection, app: Connection, worker: Connection;
let A: TestTenant, B: TestTenant;

async function expectDbError(p: Promise<unknown>, re: RegExp) {
  try { await p; } catch (e) {
    let msg = ""; for (let c: any = e; c; c = c.cause) msg += `${c.message} | `;
    expect(msg).toMatch(re); return;
  }
  throw new Error("Expected rejection");
}

/** An ACCEPTED extraction proposal with two rows, inserted as a fixture. */
async function acceptedExtraction(t: TestTenant, f: FileFixture, status: "accepted" | "pending" = "accepted") {
  const runId = randomUUID(), jobId = randomUUID(), id = randomUUID();
  await withTenant(owner.db, { tenantId: t.tenantId }, async (tx) => {
    await tx.execute(sql`insert into jobs (id, tenant_id, type, payload, status) values (${jobId}, ${t.tenantId}, 'file.uploaded', '{}', 'succeeded')`);
    await tx.insert(s.agentRuns).values({ id: runId, tenantId: t.tenantId, jobId, agentName: "extraction", agentVersion: "1", event: "file.uploaded", fileId: f.fileId, status: "succeeded" });
    await tx.insert(s.proposals).values({ id, tenantId: t.tenantId, runId, fileId: f.fileId, requestId: f.requestId, itemId: f.itemId, kind: "extraction", schemaKey: "trial_balance", title: "TB", payload: { sheet: "S", schema: "trial_balance" }, confidence: "0.9",
      ...(status === "accepted" ? { status: "accepted" as const, decidedBy: t.users.reviewer, decidedAt: new Date() } : {}) });
    await tx.insert(s.extractedRows).values([1, 2].map((n) => ({ tenantId: t.tenantId, proposalId: id, position: n, sheet: "S", sourceRow: n + 1, values: { debit: "10" }, cells: {} })));
  });
  return id;
}
/** Any accepted/pending extraction of the given schema, optionally with a payload. */
async function extractionOf(t: TestTenant, f: FileFixture, schemaKey: string, status: "accepted" | "pending" = "accepted", payload: object = { sheet: "S" }) {
  const runId = randomUUID(), jobId = randomUUID(), id = randomUUID();
  await withTenant(owner.db, { tenantId: t.tenantId }, async (tx) => {
    await tx.execute(sql`insert into jobs (id, tenant_id, type, payload, status) values (${jobId}, ${t.tenantId}, 'file.uploaded', '{}', 'succeeded')`);
    await tx.insert(s.agentRuns).values({ id: runId, tenantId: t.tenantId, jobId, agentName: "x", agentVersion: "1", event: "file.uploaded", fileId: f.fileId, status: "succeeded" });
    await tx.insert(s.proposals).values({ id, tenantId: t.tenantId, runId, fileId: f.fileId, requestId: f.requestId, itemId: f.itemId, kind: "extraction", schemaKey, title: schemaKey, payload: { schema: schemaKey, ...payload }, confidence: "0.9",
      ...(status === "accepted" ? { status: "accepted" as const, decidedBy: t.users.reviewer, decidedAt: new Date() } : {}) });
    if (schemaKey === "trial_balance") await tx.insert(s.extractedRows).values([1, 2, 3].map((n) => ({ tenantId: t.tenantId, proposalId: id, position: n, sheet: "S", sourceRow: n + 1, values: { account_code: `${n}000`, debit: "10", credit: "0" }, cells: {} })));
  });
  return id;
}
async function validationJob(t: TestTenant, f: FileFixture, proposalId: string, who = "w1") {
  const type = `proposal.accepted.${randomUUID().slice(0, 8)}`;
  await withTenant(app.db, { tenantId: t.tenantId }, (tx) => tx.insert(s.jobs).values({ tenantId: t.tenantId, type, payload: { proposalId, fileId: f.fileId } }));
  return ((await worker.db.execute(sql`select id from jobs_claim(${who}, ARRAY[${type}]::text[], 1, 600)`)).rows[0] as any).id as string;
}
const finding = (source: string, extra: object = {}) => ({
  kind: "finding", schema_key: "trial_balance", source_proposal_id: source, rule_id: "tb_footing", title: "Debits and credits differ", detail: "by 50",
  payload: { rule_id: "tb_footing", dedupe: "S", summary: "x" }, confidence: 1, severity: "error", ...extra,
});
const save = (job: string, proposals: object[], who = "w1") =>
  worker.db.execute(sql`select agent_save_results(${job}::uuid, ${who}, 'validation', '1.0.0', '{"status":"succeeded","detail":"ok"}'::jsonb, ${JSON.stringify(proposals)}::jsonb, '[]'::jsonb) as ids`);
const ids = (r: any) => (r.rows[0] as any).ids as string[];

beforeAll(async () => {
  owner = connect(TEST_OWNER_URL, { max: 4 }); app = connect(TEST_APP_URL, { max: 4 }); worker = connect(TEST_WORKER_URL, { max: 4 });
  A = await createTestTenant(owner, "va"); B = await createTestTenant(owner, "vb");
});
afterAll(async () => { await owner.close(); await app.close(); await worker.close(); });

describe("agent_get_proposal", () => {
  it("hands the worker only an ACCEPTED extraction, with its rows, rule settings and the external-LLM flag", async () => {
    const f = await createFileFixture(owner, A);
    const pid = await acceptedExtraction(A, f);
    await withTenant(app.db, { tenantId: A.tenantId, userId: A.users.manager }, (tx) => tx.insert(s.ruleSettings).values({ tenantId: A.tenantId, ruleId: "tb_footing", enabled: true, params: { tolerance: "1" }, updatedBy: A.users.manager }));
    const job = await validationJob(A, f, pid);
    const r = ((await worker.db.execute(sql`select agent_get_proposal(${job}::uuid, 'w1') as d`)).rows[0] as any).d;
    expect(r.proposal).toMatchObject({ id: pid, schema_key: "trial_balance", file_id: f.fileId });
    expect(r.rows).toHaveLength(2); expect(r.rows[0].source_row).toBe(2);
    expect(r.settings).toEqual([{ rule_id: "tb_footing", enabled: true, params: { tolerance: "1" } }]);
    expect(r.tenant).toEqual({ external_llm_enabled: false });
    expect(r.request.id).toBe(f.requestId);
  });

  it("returns nothing for pending/rejected extractions, other workers, or another tenant's proposal", async () => {
    const f = await createFileFixture(owner, A);
    const pending = await acceptedExtraction(A, f, "pending");
    const job = await validationJob(A, f, pending);
    expect(((await worker.db.execute(sql`select agent_get_proposal(${job}::uuid, 'w1') as d`)).rows[0] as any).d).toBeNull();
    await expectDbError(worker.db.execute(sql`select agent_get_proposal(${job}::uuid, 'intruder')`), /not held by this worker/);
    const fb = await createFileFixture(owner, B);
    const theirs = await acceptedExtraction(B, fb);
    const crafted = await validationJob(A, f, theirs); // tenant A job, tenant B proposal
    expect(((await worker.db.execute(sql`select agent_get_proposal(${crafted}::uuid, 'w1') as d`)).rows[0] as any).d).toBeNull();
  });
});

describe("agent_save_results for findings", () => {
  it("stores findings linked to their source, with agent-authored audit", async () => {
    const f = await createFileFixture(owner, A);
    const pid = await acceptedExtraction(A, f);
    const job = await validationJob(A, f, pid);
    const [fid] = ids(await save(job, [finding(pid)]));
    const row = (await withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.select().from(s.proposals).where(sql`${s.proposals.id} = ${fid}`)))[0]!;
    expect(row).toMatchObject({ kind: "finding", sourceProposalId: pid, ruleId: "tb_footing", status: "pending", severity: "error", requestId: f.requestId });
    const ev = await withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.select().from(s.auditEvents).where(sql`${s.auditEvents.entityId} = ${fid}`));
    expect(ev[0]).toMatchObject({ action: "proposal.created", actorType: "agent", summary: expect.stringContaining("Raised finding") });
  });

  it("refuses findings that do not reference the job's own accepted extraction", async () => {
    const f = await createFileFixture(owner, A);
    const pid = await acceptedExtraction(A, f);
    const other = await acceptedExtraction(A, await createFileFixture(owner, A));
    const job = await validationJob(A, f, pid);
    await expectDbError(save(job, [finding(other)]), /must reference the proposal its job was created for/);
    await expectDbError(save(job, [finding(pid, { source_proposal_id: null })]), /must reference/);
  });

  it("a re-run supersedes earlier PENDING findings of the same rule and key, never decided ones", async () => {
    const f = await createFileFixture(owner, A);
    const pid = await acceptedExtraction(A, f);
    const [first] = ids(await save(await validationJob(A, f, pid), [finding(pid)]));
    const [second] = ids(await save(await validationJob(A, f, pid), [finding(pid)]));
    const status = async (id: string) => (await withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.select().from(s.proposals).where(sql`${s.proposals.id} = ${id}`)))[0]!.status;
    expect(await status(first!)).toBe("superseded"); expect(await status(second!)).toBe("pending");
    await withTenant(app.db, { tenantId: A.tenantId, userId: A.users.reviewer }, (tx) => tx.update(s.proposals).set({ status: "accepted", decidedBy: A.users.reviewer, decidedAt: new Date() }).where(sql`${s.proposals.id} = ${second}`));
    const [third] = ids(await save(await validationJob(A, f, pid), [finding(pid)]));
    expect(await status(second!)).toBe("accepted"); expect(await status(third!)).toBe("pending");
    // a re-run that raises nothing retires the still-pending findings it no longer reproduces
    ids(await save(await validationJob(A, f, pid), []));
    expect(await status(third!)).toBe("superseded");
    // a different key (another sheet) is independent
    const [keyA, keyB] = ids(await save(await validationJob(A, f, pid), [finding(pid), finding(pid, { payload: { rule_id: "tb_footing", dedupe: "Other sheet" } })]));
    expect(await status(keyA!)).toBe("pending"); expect(await status(keyB!)).toBe("pending");
  });
});

describe("rule settings are guarded by role in the database", () => {
  const write = (t: TestTenant, userId: string | undefined, rule: string, enabled = false) =>
    withTenant(app.db, { tenantId: t.tenantId, userId }, (tx) => tx.execute(sql`insert into rule_settings (tenant_id, rule_id, enabled, updated_by) values (${t.tenantId}, ${rule}, ${enabled}, ${userId ?? A.users.manager})
      on conflict (tenant_id, rule_id) do update set enabled = excluded.enabled`));

  it("allows tax managers and tenant admins; refuses everyone else, including a request with no acting user", async () => {
    await write(A, A.users.manager, "r_mgr"); await write(A, A.users.admin, "r_adm");
    for (const [who, name] of [[A.users.contributor, "contributor"], [A.users.reviewer, "reviewer"], [A.users.auditor, "auditor"], [undefined, "anonymous"]] as const) {
      await expectDbError(write(A, who, `r_${name}`), /only tax managers and tenant admins/);
    }
  });

  it("records who changed it, ignoring any claimed updater, and is tenant-isolated", async () => {
    await withTenant(app.db, { tenantId: A.tenantId, userId: A.users.admin }, (tx) => tx.execute(sql`insert into rule_settings (tenant_id, rule_id, enabled, updated_by) values (${A.tenantId}, 'r_who', true, ${A.users.manager})`));
    const row = (await withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.select().from(s.ruleSettings).where(sql`${s.ruleSettings.ruleId} = 'r_who'`)))[0]!;
    expect(row.updatedBy).toBe(A.users.admin);
    expect(await withTenant(app.db, { tenantId: B.tenantId }, (tx) => tx.select().from(s.ruleSettings))).toHaveLength(0);
    await expectDbError(withTenant(app.db, { tenantId: B.tenantId, userId: B.users.manager }, (tx) => tx.execute(sql`insert into rule_settings (tenant_id, rule_id, enabled, updated_by) values (${A.tenantId}, 'x', true, ${B.users.manager})`)), /row-level security|policy/i);
  });

  it("the worker role cannot read or write settings directly", async () => {
    await expectDbError(worker.db.execute(sql`select * from rule_settings`), /permission denied/i);
  });
});

describe("agent_get_related (cross-file read for reconciliation)", () => {
  const related = async (job: string, who = "w1") => ((await worker.db.execute(sql`select agent_get_related(${job}::uuid, ${who}) as d`)).rows[0] as any).d;

  it("returns the ACCEPTED trial balances and documents of the SAME request, with rows only for trial balances", async () => {
    const f = await createFileFixture(owner, A);
    const g = await createFileInRequest(owner, A, f);
    const tb = await extractionOf(A, f, "trial_balance");
    const doc = await extractionOf(A, g, "supporting_document", "accepted", { document_type: "Balance confirmation" });
    await extractionOf(A, g, "supporting_document", "pending");                 // pending: not shared
    const job = await validationJob(A, f, tb);
    const r = await related(job);
    expect(r.self).toBe(tb);
    expect(r.request.id).toBe(f.requestId);
    const byId = Object.fromEntries(r.proposals.map((p: any) => [p.id, p]));
    expect(Object.keys(byId).sort()).toEqual([tb, doc].sort());
    expect(byId[tb].rows).toHaveLength(3); expect(byId[tb].row_total).toBe(3); expect(byId[doc].rows).toEqual([]); expect(byId[doc].row_total).toBe(0);
    expect(byId[doc]).toMatchObject({ file_name: "confirmation.docx", item_title: "Supporting document", payload: { document_type: "Balance confirmation" } });
    expect(r.tenant).toEqual({ external_llm_enabled: false });
  });

  it("never reaches another request, another tenant, or a job the worker does not hold", async () => {
    const f = await createFileFixture(owner, A);
    const other = await createFileFixture(owner, A);                               // a different request in the same tenant
    const tb = await extractionOf(A, f, "trial_balance");
    const otherTb = await extractionOf(A, other, "trial_balance");
    const fb = await createFileFixture(owner, B);
    const theirs = await extractionOf(B, fb, "trial_balance");
    const r = await related(await validationJob(A, f, tb));
    expect(r.proposals.map((p: any) => p.id)).toEqual([tb]);
    expect(r.proposals.map((p: any) => p.id)).not.toContain(otherTb);
    // a job in tenant A that names tenant B's proposal gets nothing
    expect(await related(await validationJob(A, f, theirs))).toBeNull();
    // a job whose own proposal is not accepted gets nothing
    const pending = await extractionOf(A, f, "trial_balance", "pending");
    expect(await related(await validationJob(A, f, pending))).toBeNull();
    const held = await validationJob(A, f, tb);
    await expectDbError(worker.db.execute(sql`select agent_get_related(${held}::uuid, 'intruder')`), /not held by this worker/);
  });

  it("is executable by the worker role only", async () => {
    const f = await createFileFixture(owner, A);
    const job = await validationJob(A, f, await extractionOf(A, f, "trial_balance"));
    await expectDbError(app.db.execute(sql`select agent_get_related(${job}::uuid, 'w1')`), /permission denied/i);
  });
});

describe("agent_save_results retirement is scoped to the saving agent", () => {
  it("a second agent's run does not retire the first agent's open findings on the same source", async () => {
    const f = await createFileFixture(owner, A);
    const pid = await extractionOf(A, f, "trial_balance");
    const saveAs = (job: string, agent: string, proposals: object[]) =>
      worker.db.execute(sql`select agent_save_results(${job}::uuid, 'w1', ${agent}, '1.0.0', '{"status":"succeeded","detail":"ok"}'::jsonb, ${JSON.stringify(proposals)}::jsonb, '[]'::jsonb) as ids`);
    const status = async (id: string) => (await withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.select().from(s.proposals).where(sql`${s.proposals.id} = ${id}`)))[0]!.status;
    const [v] = ids(await saveAs(await validationJob(A, f, pid), "validation", [finding(pid)]));
    const [r] = ids(await saveAs(await validationJob(A, f, pid), "reconciliation", [finding(pid, { rule_id: "rc_amount_unmatched", payload: { rule_id: "rc_amount_unmatched", dedupe: "d", summary: "x" } })]));
    expect(await status(v!)).toBe("pending");                                       // not retired by the other agent
    expect(await status(r!)).toBe("pending");
    ids(await saveAs(await validationJob(A, f, pid), "reconciliation", []));        // reconciliation re-runs and raises nothing
    expect(await status(r!)).toBe("superseded");                                    // its own is retired
    expect(await status(v!)).toBe("pending");                                       // the validation finding survives
  });
});
