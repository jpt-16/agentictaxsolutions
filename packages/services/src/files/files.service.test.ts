import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { ForbiddenError, InvalidTransitionError } from "@taxops/core";
import { connect, withTenant, departments, users, type Connection } from "@taxops/db";
import { createTestTenant, TEST_APP_URL, TEST_OWNER_URL, type TestTenant } from "@taxops/db/src/testing";
import {
  createRequest, downloadFile, getRequestDetail, listAudit, loadSession, NotFoundError, previewFile, publishRequest, submitWithFiles,
  MemoryStorage, EicarScanner, ScanUnavailableError, UploadRejectedError, type FileDeps, type Scanner, type ServiceContext,
} from "../index";
import { EICAR, makeXlsx } from "./files.unit.test";

let owner: Connection, app: Connection;
let A: TestTenant, B: TestTenant;
let contributor2: string;
let storage: MemoryStorage;
let scans = 0;
let scannerMode: "ok" | "down" = "ok";
const scanner: Scanner = {
  name: "test-scanner",
  async scan(bytes) {
    scans++;
    if (scannerMode === "down") throw new ScanUnavailableError();
    return new EicarScanner().scan(bytes);
  },
};
const deps = (): FileDeps => ({ storage, scanner });

const ctxFor = async (t: TestTenant, userId: string): Promise<ServiceContext> => ({ db: app.db, session: (await loadSession(app.db, t.tenantId, userId))! });
const mgr = () => ctxFor(A, A.users.manager);
const con = () => ctxFor(A, A.users.contributor);
const con2 = () => ctxFor(A, contributor2);
const aud = () => ctxFor(A, A.users.auditor);
const rev = () => ctxFor(A, A.users.reviewer);

async function openItem(title = "Files test") {
  const m = await mgr();
  const r = await createRequest(m, { title, taxYear: 2025, dueDate: "2027-01-01", items: [{ title: "Trial balance", dataType: "trial_balance" }], assignees: [{ type: "department", id: A.departmentId }] });
  await publishRequest(m, r.id);
  return { requestId: r.id, itemId: (await getRequestDetail(m, r.id)).items[0]!.id };
}
const jobsOf = async (tenantId: string) => (await withTenant(owner.db, { tenantId }, (tx) => tx.execute(sql`select type, payload from jobs order by created_at`))).rows as any[];

beforeAll(async () => {
  owner = connect(TEST_OWNER_URL, { max: 4 }); app = connect(TEST_APP_URL, { max: 8 });
  A = await createTestTenant(owner, "fa"); B = await createTestTenant(owner, "fb");
  const otherDept = randomUUID(); contributor2 = randomUUID();
  await withTenant(owner.db, { tenantId: A.tenantId }, async (tx) => {
    await tx.insert(departments).values({ id: otherDept, tenantId: A.tenantId, name: "Elsewhere", code: "EW" });
    await tx.insert(users).values({ id: contributor2, tenantId: A.tenantId, email: `c2@${A.slug}.test`, name: "Dan Else", role: "contributor", departmentId: otherDept });
  });
});
afterAll(async () => { await owner.close(); await app.close(); });
const reset = () => { storage = new MemoryStorage(); scans = 0; scannerMode = "ok"; };

describe("uploading", () => {
  it("stores a scanned file, versions the submission, audits it and queues a job — atomically", async () => {
    reset();
    const { requestId, itemId } = await openItem("Happy path");
    const xlsx = await makeXlsx([["Account", "Debit", "Credit"], ["1000", 100, 0], ["2000", 0, 100]]);
    await submitWithFiles(await con(), deps(), itemId, { note: "TB attached" }, [{ name: "TB_FY25.xlsx", bytes: xlsx }]);

    const detail = await getRequestDetail(await mgr(), requestId);
    const sub = detail.items[0]!.submissions[0]!;
    expect(sub.version).toBe(1);
    expect(sub.files).toHaveLength(1);
    expect(sub.files[0]).toMatchObject({ name: "TB_FY25.xlsx", previewable: true });
    expect(storage.objects.size).toBe(1);
    expect([...storage.objects.keys()][0]).toMatch(new RegExp(`^${A.tenantId}/`));

    const log = (await listAudit(await aud(), { requestRef: requestId })).rows.find((e) => e.action === "item.submitted")!;
    expect((log.after as any).files[0]).toMatchObject({ name: "TB_FY25.xlsx", scanner: "test-scanner" });
    const jobs = (await jobsOf(A.tenantId)).filter((j) => j.payload.itemId === itemId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ type: "file.uploaded", payload: { kind: "xlsx", requestId } });
  });

  it("versions resubmissions: each version keeps its own files", async () => {
    reset();
    const { requestId, itemId } = await openItem("Versions");
    await submitWithFiles(await con(), deps(), itemId, { note: "first" }, [{ name: "a.csv", bytes: Buffer.from("x,1\n") }]);
    await (await import("../requests")).reviewItem(await rev(), itemId, { decision: "changes_requested", rationale: "Need fixes" });
    await submitWithFiles(await con(), deps(), itemId, { note: "second" }, [{ name: "a.csv", bytes: Buffer.from("x,2\n") }, { name: "b.csv", bytes: Buffer.from("y,1\n") }]);
    const subs = (await getRequestDetail(await mgr(), requestId)).items[0]!.submissions;
    expect(subs.map((s) => [s.version, s.files.length])).toEqual([[2, 2], [1, 1]]);
  });

  it("blocks infected files: nothing stored, submission not created, rejection audited", async () => {
    reset();
    const { requestId, itemId } = await openItem("Virus");
    await expect(submitWithFiles(await con(), deps(), itemId, { note: "here you go" }, [{ name: "evil.txt", bytes: Buffer.from(`hello ${EICAR}`) }]))
      .rejects.toThrow(/blocked by the virus scan/);
    expect(storage.objects.size).toBe(0);
    const d = await getRequestDetail(await mgr(), requestId);
    expect(d.items[0]!.status).toBe("pending");
    expect(d.items[0]!.submissions).toHaveLength(0);
    const rej = (await listAudit(await aud(), { requestRef: requestId })).rows.find((e) => e.action === "file.rejected")!;
    expect(rej.after).toMatchObject({ file: "evil.txt", detail: expect.stringContaining("Eicar") });
  });

  it("is all-or-nothing when one of several files is rejected", async () => {
    reset();
    const { itemId } = await openItem("Mixed");
    const err = await submitWithFiles(await con(), deps(), itemId, { note: "mixed bag" }, [
      { name: "good.csv", bytes: Buffer.from("a,b\n") }, { name: "macro.xlsm", bytes: Buffer.from("x") },
    ]).catch((e) => e);
    expect(err).toBeInstanceOf(UploadRejectedError);
    expect(err.reasons).toEqual([{ file: "macro.xlsm", reason: expect.stringMatching(/Macro-enabled/) }]);
    expect(storage.objects.size).toBe(0);
  });

  it("fails closed when the scanner is down", async () => {
    reset();
    const { itemId } = await openItem("Scanner down");
    scannerMode = "down";
    await expect(submitWithFiles(await con(), deps(), itemId, { note: "please" }, [{ name: "a.csv", bytes: Buffer.from("a\n") }]))
      .rejects.toThrow(/cannot be scanned right now/);
    expect(storage.objects.size).toBe(0);
  });

  it("does no scanning or storage work for people who may not submit", async () => {
    reset();
    const { itemId } = await openItem("Authz");
    const f = [{ name: "a.csv", bytes: Buffer.from("a\n") }];
    await expect(submitWithFiles(await con2(), deps(), itemId, { note: "outsider" }, f)).rejects.toBeInstanceOf(NotFoundError);
    await expect(submitWithFiles(await rev(), deps(), itemId, { note: "reviewer" }, f)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(submitWithFiles(await ctxFor(B, B.users.contributor), deps(), itemId, { note: "other tenant" }, f)).rejects.toBeInstanceOf(NotFoundError);
    expect(scans).toBe(0);
    expect(storage.objects.size).toBe(0);
  });

  it("removes stored blobs if the database transaction fails", async () => {
    reset();
    const { itemId } = await openItem("Cleanup");
    await submitWithFiles(await con(), deps(), itemId, { note: "first" }, [{ name: "a.csv", bytes: Buffer.from("a\n") }]);
    const before = storage.objects.size;
    // Item is now 'submitted', so a second submission passes the pre-check but fails the transition inside the transaction.
    await expect(submitWithFiles(await con(), deps(), itemId, { note: "again" }, [{ name: "b.csv", bytes: Buffer.from("b\n") }])).rejects.toBeInstanceOf(InvalidTransitionError);
    expect(storage.objects.size).toBe(before);
  });

  it("enforces file-count limits", async () => {
    reset();
    const { itemId } = await openItem("Limits");
    const many = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.csv`, bytes: Buffer.from("a\n") }));
    await expect(submitWithFiles(await con(), deps(), itemId, { note: "lots" }, many)).rejects.toThrow(/at most 10/);
  });
});

describe("downloading and viewing", () => {
  async function withFile() {
    reset();
    const { requestId, itemId } = await openItem("Download");
    const bytes = await makeXlsx([["Account", "Amount"], ["1000", 5]]);
    await submitWithFiles(await con(), deps(), itemId, { note: "file" }, [{ name: "tb.xlsx", bytes }]);
    const fileId = (await getRequestDetail(await mgr(), requestId)).items[0]!.submissions[0]!.files[0]!.id;
    return { requestId, fileId, bytes };
  }

  it("returns the exact bytes to authorized people and audits who accessed what", async () => {
    const { requestId, fileId, bytes } = await withFile();
    const got = await downloadFile(await aud(), deps(), fileId);
    expect(got.bytes.equals(bytes)).toBe(true);
    expect(got.name).toBe("tb.xlsx");
    await downloadFile(await con(), deps(), fileId);
    const events = (await listAudit(await aud(), { requestRef: requestId })).rows.filter((e) => e.action === "file.downloaded");
    const who = events.map((e) => e.actorLabel).join("|");
    expect(who).toContain("Al Auditor");
    expect(who).toContain("Cat Contributor");
    expect(events).toHaveLength(2);
  });

  it("denies people who cannot see the request, and other tenants, as 'not found'", async () => {
    const { fileId } = await withFile();
    await expect(downloadFile(await con2(), deps(), fileId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(downloadFile(await ctxFor(B, B.users.manager), deps(), fileId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(downloadFile(await ctxFor(B, B.users.auditor), deps(), fileId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(downloadFile(await con(), deps(), randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });

  it("detects a tampered blob through its stored hash", async () => {
    const { fileId } = await withFile();
    const key = [...storage.objects.keys()][0]!;
    storage.objects.set(key, Buffer.from("tampered"));
    await expect(downloadFile(await mgr(), deps(), fileId)).rejects.toThrow(/integrity check/);
  });

  it("previews spreadsheets, rejects other types, and keeps views out of the request activity feed", async () => {
    const { requestId, fileId } = await withFile();
    const p = await previewFile(await mgr(), deps(), fileId);
    expect(p.preview.rows).toEqual([["Account", "Amount"], ["1000", "5"]]);
    const feed = (await getRequestDetail(await mgr(), requestId)).activity.map((a) => a.action);
    expect(feed).not.toContain("file.viewed");
    expect((await listAudit(await aud(), { requestRef: requestId })).rows.some((e) => e.action === "file.viewed")).toBe(true);

    reset();
    const { itemId } = await openItem("PDF preview");
    await submitWithFiles(await con(), deps(), itemId, { note: "pdf" }, [{ name: "memo.pdf", bytes: Buffer.from("%PDF-1.7\nbody") }]);
    const pdfId = (await getRequestDetail(await mgr(), (await openItemRequest(itemId)))).items[0]!.submissions[0]!.files[0]!.id;
    await expect(previewFile(await mgr(), deps(), pdfId)).rejects.toBeInstanceOf(UploadRejectedError);
  });
});

async function openItemRequest(itemId: string) {
  const r = await withTenant(owner.db, { tenantId: A.tenantId }, (tx) => tx.execute(sql`select request_id from request_items where id = ${itemId}`));
  return (r.rows[0] as any).request_id as string;
}
