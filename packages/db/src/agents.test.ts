import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { connect, withTenant, type Connection } from "./client";
import { verifyAuditChain } from "./audit";
import * as s from "./schema";
import { createFileFixture, createTestTenant, TEST_APP_URL, TEST_OWNER_URL, TEST_WORKER_URL, type FileFixture, type TestTenant } from "./testing";

let owner: Connection, app: Connection, worker: Connection;
let A: TestTenant, B: TestTenant;

async function expectDbError(p: Promise<unknown>, re: RegExp) {
  try { await p; } catch (e) {
    let msg = ""; for (let c: any = e; c; c = c.cause) msg += `${c.message} | `;
    expect(msg).toMatch(re); return;
  }
  throw new Error("Expected rejection");
}
/** Enqueues a file.uploaded job for a tenant and claims it as `who`. Returns the job id. */
async function claimedJob(t: TestTenant, fileId: string, who = "w1") {
  const type = `agent.test.${randomUUID().slice(0, 8)}`;
  await withTenant(app.db, { tenantId: t.tenantId }, (tx) => tx.insert(s.jobs).values({ tenantId: t.tenantId, type, payload: { fileId } }));
  const rows = (await worker.db.execute(sql`select id from jobs_claim(${who}, ARRAY[${type}]::text[], 1, 600)`)).rows as any[];
  return rows[0].id as string;
}
const proposal = (sheet: string, extra: object = {}) => ({
  kind: "extraction", schema_key: "trial_balance", title: `Trial balance – ${sheet}`, detail: "d",
  payload: { sheet, schema: "trial_balance" }, confidence: 0.91, severity: "info", ...extra,
});
const save = (job: string, proposals: object[], rows: object[] = [], who = "w1", run: object = { status: "succeeded", detail: "ok", llm_calls: 0, duration_ms: 5 }) =>
  worker.db.execute(sql`select agent_save_results(${job}::uuid, ${who}, 'extraction', '1.0.0', ${JSON.stringify(run)}::jsonb, ${JSON.stringify(proposals)}::jsonb, ${JSON.stringify(rows)}::jsonb) as ids`);
const idsOf = (r: any) => ((r.rows[0] as any).ids as string[]);

beforeAll(async () => {
  owner = connect(TEST_OWNER_URL, { max: 4 }); app = connect(TEST_APP_URL, { max: 4 }); worker = connect(TEST_WORKER_URL, { max: 4 });
  A = await createTestTenant(owner, "ga"); B = await createTestTenant(owner, "gb");
});
afterAll(async () => { await owner.close(); await app.close(); await worker.close(); });

describe("agent_get_file (worker read access)", () => {
  it("returns only the file of the job the worker holds, with governance flags (default off)", async () => {
    const f = await createFileFixture(owner, A);
    const job = await claimedJob(A, f.fileId);
    const r = (await worker.db.execute(sql`select * from agent_get_file(${job}::uuid, 'w1')`)).rows[0] as any;
    expect(r).toMatchObject({ tenant_id: A.tenantId, file_id: f.fileId, request_id: f.requestId, item_id: f.itemId, storage_key: f.storageKey, ai_extraction_enabled: false, external_llm_enabled: false });
    await withTenant(owner.db, { tenantId: A.tenantId }, (tx) => tx.execute(sql`update tenants set ai_extraction_enabled = true, external_llm_enabled = true`));
    const again = (await worker.db.execute(sql`select * from agent_get_file(${job}::uuid, 'w1')`)).rows[0] as any;
    expect(again).toMatchObject({ ai_extraction_enabled: true, external_llm_enabled: true });
  });

  it("refuses other workers, unclaimed jobs and finished jobs", async () => {
    const f = await createFileFixture(owner, A);
    const job = await claimedJob(A, f.fileId, "holder");
    await expectDbError(worker.db.execute(sql`select * from agent_get_file(${job}::uuid, 'intruder')`), /not held by this worker/);
    await expectDbError(worker.db.execute(sql`select * from agent_get_file(${randomUUID()}::uuid, 'holder')`), /not held by this worker/);
    await worker.db.execute(sql`select jobs_complete(${job}::uuid, 'holder')`);
    await expectDbError(worker.db.execute(sql`select * from agent_get_file(${job}::uuid, 'holder')`), /not held by this worker/);
  });

  it("cannot be tricked into reading another tenant's file through a crafted payload", async () => {
    const other = await createFileFixture(owner, B);
    const job = await claimedJob(A, other.fileId); // tenant A job pointing at tenant B's file
    const rows = (await worker.db.execute(sql`select * from agent_get_file(${job}::uuid, 'w1')`)).rows;
    expect(rows).toHaveLength(0);
    await expectDbError(save(job, [proposal("S")]), /file for job not found/);
  });
});

describe("agent_save_results", () => {
  it("stores run, proposals, ordered rows and agent-authored audit events; tenant comes from the job", async () => {
    const f = await createFileFixture(owner, A);
    const job = await claimedJob(A, f.fileId);
    const ids = idsOf(await save(job, [proposal("S1"), proposal("S2")], [
      { proposal_index: 0, sheet: "S1", source_row: 2, values: { account_code: "1000", debit: "10.50", credit: "0" }, cells: { debit: "C2" }, issues: [] },
      { proposal_index: 0, sheet: "S1", source_row: 3, values: { account_code: "2000", debit: "0", credit: "10.50" }, cells: { credit: "D3" }, issues: ["x"] },
      { proposal_index: 1, sheet: "S2", source_row: 2, values: { account_code: "1000" }, cells: {}, issues: [] },
    ]));
    expect(ids).toHaveLength(2);
    const d = await withTenant(app.db, { tenantId: A.tenantId }, async (tx) => ({
      props: await tx.select().from(s.proposals).where(sql`${s.proposals.fileId} = ${f.fileId}`),
      rows: await tx.select().from(s.extractedRows).orderBy(s.extractedRows.position),
      runs: await tx.select().from(s.agentRuns).where(sql`${s.agentRuns.fileId} = ${f.fileId}`),
      audit: await tx.select().from(s.auditEvents).where(sql`${s.auditEvents.requestRef} = ${f.requestId}`),
    }));
    expect(d.props).toHaveLength(2);
    expect(d.props.every((p) => p.tenantId === A.tenantId && p.requestId === f.requestId && p.itemId === f.itemId && p.status === "pending")).toBe(true);
    const rowsOfS1 = d.rows.filter((r) => r.proposalId === ids[0]);
    expect(rowsOfS1.map((r) => r.sourceRow)).toEqual([2, 3]);
    expect(d.runs[0]).toMatchObject({ agentName: "extraction", status: "succeeded", jobId: job });
    const events = d.audit.filter((e) => e.actorType === "agent");
    expect(events.map((e) => e.action).sort()).toEqual(["agent.run_succeeded", "proposal.created", "proposal.created"]);
    expect(events[0]!.actorLabel).toBe("Extraction v1.0.0");
    const chain = await withTenant(app.db, { tenantId: A.tenantId }, (tx) => verifyAuditChain(tx, A.tenantId));
    expect(chain.ok).toBe(true);
    expect(await withTenant(app.db, { tenantId: B.tenantId }, (tx) => tx.select().from(s.proposals).where(sql`${s.proposals.fileId} = ${f.fileId}`))).toHaveLength(0);
  });

  it("is idempotent: a retried job returns the original ids and adds nothing", async () => {
    const f = await createFileFixture(owner, A);
    const job = await claimedJob(A, f.fileId);
    const first = idsOf(await save(job, [proposal("S")], [{ proposal_index: 0, sheet: "S", source_row: 2, values: {}, cells: {} }]));
    const second = idsOf(await save(job, [proposal("S")], [{ proposal_index: 0, sheet: "S", source_row: 2, values: {}, cells: {} }]));
    expect(second).toEqual(first);
    const n = await withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.select().from(s.proposals).where(sql`${s.proposals.fileId} = ${f.fileId}`));
    expect(n).toHaveLength(1);
  });

  it("supersedes earlier PENDING output for the same sheet on a re-run, but never touches decided proposals", async () => {
    const f = await createFileFixture(owner, A);
    const [first] = idsOf(await save(await claimedJob(A, f.fileId), [proposal("S")]));
    const [second] = idsOf(await save(await claimedJob(A, f.fileId), [proposal("S")]));
    const status = async (id: string) => (await withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.select().from(s.proposals).where(sql`${s.proposals.id} = ${id}`)))[0]!.status;
    expect(await status(first!)).toBe("superseded");
    expect(await status(second!)).toBe("pending");
    await withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.update(s.proposals).set({ status: "accepted", decidedBy: A.users.reviewer, decidedAt: new Date() }).where(sql`${s.proposals.id} = ${second}`));
    const [third] = idsOf(await save(await claimedJob(A, f.fileId), [proposal("S")]));
    expect(await status(second!)).toBe("accepted");
    expect(await status(third!)).toBe("pending");
  });

  it("records skipped runs with no proposals, and rejects other workers, bad values and oversized output", async () => {
    const f = await createFileFixture(owner, A);
    const job = await claimedJob(A, f.fileId);
    await expectDbError(save(job, [], [], "intruder"), /not held by this worker/);
    await expectDbError(save(job, [proposal("S", { severity: "catastrophic" })]), /invalid input value for enum/);
    await expectDbError(save(job, [proposal("S", { confidence: 1.5 })]), /confidence_range|check/);
    await expectDbError(save(job, Array.from({ length: 201 }, (_, i) => proposal(`S${i}`))), /exceeds allowed size/);
    expect(idsOf(await save(job, [], [], "w1", { status: "skipped", detail: "tenant has not enabled AI extraction" }))).toEqual([]);
    const ev = await withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.select().from(s.auditEvents).where(sql`${s.auditEvents.requestRef} = ${f.requestId}`));
    expect(ev.map((e) => e.action)).toContain("agent.run_skipped");
  });
});

describe("app role vs agent output", () => {
  async function pendingProposal() {
    const f = await createFileFixture(owner, A);
    const [id] = idsOf(await save(await claimedJob(A, f.fileId), [proposal("S")], [{ proposal_index: 0, sheet: "S", source_row: 2, values: {}, cells: {} }]));
    return { id: id!, f };
  }
  const decide = (t: TestTenant, id: string, set: Partial<typeof s.proposals.$inferInsert>) =>
    withTenant(app.db, { tenantId: t.tenantId }, (tx) => tx.update(s.proposals).set(set).where(sql`${s.proposals.id} = ${id}`).returning());

  it("cannot create proposals, rows or runs (only the worker functions can)", async () => {
    const { f } = await pendingProposal();
    await expectDbError(withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.execute(sql`insert into proposals (tenant_id, run_id, file_id, request_id, item_id, kind, title, payload, confidence) select tenant_id, run_id, file_id, request_id, item_id, 'extraction', 'forged', '{}', 1 from proposals limit 1`)), /permission denied/i);
    await expectDbError(withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.execute(sql`delete from proposals`)), /permission denied/i);
    await expectDbError(withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.execute(sql`insert into agent_runs (tenant_id, job_id, agent_name, agent_version, event, status) values (${A.tenantId}, ${randomUUID()}, 'x', '1', 'e', 'succeeded')`)), /permission denied/i);
    await expectDbError(withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.execute(sql`update extracted_rows set sheet = 'x'`)), /permission denied/i);
    expect(f.fileId).toBeTruthy();
  });

  it("can change only decision columns", async () => {
    const { id } = await pendingProposal();
    await expectDbError(decide(A, id, { title: "rewritten" } as any), /permission denied/i);
    await expectDbError(decide(A, id, { payload: { hacked: true } } as any), /permission denied/i);
    await expectDbError(decide(A, id, { confidence: "0.999" } as any), /permission denied/i);
  });

  it("enforces a well-formed, final decision", async () => {
    const { id } = await pendingProposal();
    await expectDbError(decide(A, id, { status: "superseded", decidedBy: A.users.reviewer, decidedAt: new Date() }), /accepted or rejected/);
    await expectDbError(decide(A, id, { status: "accepted" }), /decider and time/);
    await expectDbError(decide(A, id, { status: "rejected", decidedBy: A.users.reviewer, decidedAt: new Date(), decisionNote: " " }), /requires a reason/);
    await expectDbError(decide(A, id, { status: "accepted", decidedBy: B.users.reviewer, decidedAt: new Date() }), /foreign key|violates/i); // decider must be in the same tenant
    const [ok] = await decide(A, id, { status: "rejected", decidedBy: A.users.reviewer, decidedAt: new Date(), decisionNote: "Wrong account mapping" });
    expect(ok!.status).toBe("rejected");
    await expectDbError(decide(A, id, { status: "accepted", decidedBy: A.users.reviewer, decidedAt: new Date() }), /decision is final/);
    await expectDbError(owner.db.transaction(async (tx) => { await tx.execute(sql`select set_config('app.tenant_id', ${A.tenantId}, true)`); await tx.execute(sql`update proposals set status = 'superseded' where id = ${id}`); }), /decision is final/);
  });

  it("is invisible and untouchable across tenants; the worker role has no table access to it", async () => {
    const { id } = await pendingProposal();
    expect(await withTenant(app.db, { tenantId: B.tenantId }, (tx) => tx.select().from(s.proposals).where(sql`${s.proposals.id} = ${id}`))).toHaveLength(0);
    expect(await decide(B, id, { status: "accepted", decidedBy: B.users.reviewer, decidedAt: new Date() })).toHaveLength(0);
    for (const t of ["proposals", "extracted_rows", "agent_runs"]) await expectDbError(worker.db.execute(sql.raw(`select * from ${t} limit 1`)), /permission denied/i);
  });

  it("tenants opt in: AI flags default to off and the app cannot flip them", async () => {
    const flags = await withTenant(app.db, { tenantId: B.tenantId }, (tx) => tx.select({ a: s.tenants.aiExtractionEnabled, e: s.tenants.externalLlmEnabled }).from(s.tenants));
    expect(flags[0]).toEqual({ a: false, e: false });
    await expectDbError(withTenant(app.db, { tenantId: B.tenantId }, (tx) => tx.execute(sql`update tenants set external_llm_enabled = true`)), /permission denied/i);
  });
});
