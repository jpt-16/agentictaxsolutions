import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sql } from "drizzle-orm";
import { ForbiddenError, InvalidTransitionError } from "@taxops/core";
import { comments, connect, departments, users, withTenant, type Connection } from "@taxops/db";
import { createTestTenant, TEST_APP_URL, TEST_OWNER_URL, type TestTenant } from "@taxops/db/src/testing";
import {
  createRequest, createUser, exportAudit, getRequestDetail, getTenantSettings, listAudit, listNotifications, listUsers, loadSession, markAllRead, markRead,
  NotFoundError, publishRequest, reviewItem, submitItem, sweepDeadlines, toCsv, unreadCount, updateDraftRequest, updateTenantSettings, updateUser, ConflictError,
  type ServiceContext,
} from "./index";

let owner: Connection, app: Connection;
let A: TestTenant, B: TestTenant;
let otherContributor: string;
const ctxFor = async (t: TestTenant, userId: string): Promise<ServiceContext> => ({ db: app.db, session: (await loadSession(app.db, t.tenantId, userId))! });
const mgr = () => ctxFor(A, A.users.manager), rev = () => ctxFor(A, A.users.reviewer), con = () => ctxFor(A, A.users.contributor);
const aud = () => ctxFor(A, A.users.auditor), adm = () => ctxFor(A, A.users.admin), con2 = () => ctxFor(A, otherContributor);

const titles = async (c: ServiceContext) => (await listNotifications(c)).map((n) => n.title);
async function openRequest(title: string, opts: { due?: string; assignDept?: boolean } = {}) {
  const m = await mgr();
  const r = await createRequest(m, { title, taxYear: 2025, dueDate: opts.due ?? "2027-01-01", items: [{ title: `Item for ${title}`, dataType: "other" }], assignees: [{ type: "department", id: A.departmentId }] });
  await publishRequest(m, r.id);
  return { ...r, itemId: (await getRequestDetail(m, r.id)).items[0]!.id };
}

beforeAll(async () => {
  owner = connect(TEST_OWNER_URL, { max: 4 }); app = connect(TEST_APP_URL, { max: 8 });
  A = await createTestTenant(owner, "p5a"); B = await createTestTenant(owner, "p5b");
  const dept = randomUUID(); otherContributor = randomUUID();
  await withTenant(owner.db, { tenantId: A.tenantId }, async (tx) => {
    await tx.insert(departments).values({ id: dept, tenantId: A.tenantId, name: "Elsewhere", code: "EW" });
    await tx.insert(users).values({ id: otherContributor, tenantId: A.tenantId, email: `c2@${A.slug}.test`, name: "Dan Else", role: "contributor", departmentId: dept });
  });
});
afterAll(async () => { await owner.close(); await app.close(); });

describe("notifications", () => {
  it("fan out through the workflow to exactly the right people", async () => {
    const r = await openRequest("Notify flow one");
    expect(await titles(await con())).toContain("New request: Notify flow one");           // assignee (via department)
    expect(await titles(await con2())).not.toContain("New request: Notify flow one");       // other department
    expect(await titles(await rev())).not.toContain("New request: Notify flow one");

    await submitItem(await con(), r.itemId, { note: "here is the data" });
    for (const c of [await rev(), await mgr()]) expect(await titles(c)).toContain(`Submission to review: Item for Notify flow one`);
    expect(await titles(await con())).not.toContain("Submission to review: Item for Notify flow one");

    await reviewItem(await rev(), r.itemId, { decision: "changes_requested", rationale: "Please add the FX column" });
    const back = (await listNotifications(await con())).find((n) => n.type === "review")!;
    expect(back).toMatchObject({ title: "Changes requested: Item for Notify flow one", body: "Please add the FX column", link: `/requests/${r.id}#item-${r.itemId}` });

    await submitItem(await con(), r.itemId, { note: "fixed" });
    await reviewItem(await rev(), r.itemId, { decision: "approved", rationale: "" });
    expect(await titles(await con())).toContain("Approved: Item for Notify flow one");
    expect(await titles(await mgr())).toContain("Ready to close: Notify flow one"); // creator learns the request is fully approved
  });

  it("are private to the recipient, can be marked read, and never cross tenants", async () => {
    await openRequest("Notify privacy");
    const mine = await listNotifications(await con());
    expect(mine.length).toBeGreaterThan(0);
    const before = await unreadCount(await con());
    await markRead(await con(), mine[0]!.id);
    expect(await unreadCount(await con())).toBe(before - 1);
    await markRead(await rev(), mine[1]?.id ?? mine[0]!.id); // someone else's: silently a no-op under row-level security
    expect(await unreadCount(await con())).toBe(before - 1);
    await markAllRead(await con());
    expect(await unreadCount(await con())).toBe(0);
    expect(await titles(await ctxFor(B, B.users.contributor))).not.toContain("New request: Notify privacy");
  });

  it("deadline sweep nudges the right people once, only for live requests, and is idempotent", async () => {
    const soon = await openRequest("Sweep soon", { due: "2027-03-12" });
    const late = await openRequest("Sweep late", { due: "2027-03-01" });
    await openRequest("Sweep far", { due: "2027-09-01" });
    const draft = await createRequest(await mgr(), { title: "Sweep draft", taxYear: 2025, dueDate: "2027-03-01", items: [], assignees: [] });
    const first = await sweepDeadlines(owner.db, { today: "2027-03-10" });
    expect(first.sent).toBeGreaterThanOrEqual(2);
    const t = await titles(await con());
    expect(t).toContain("Due in 2 days: Sweep soon"); expect(t).toContain("Overdue: Sweep late");
    expect(t.filter((x) => x.includes("Sweep far") && /^(Due|Overdue)/.test(x))).toEqual([]); expect(t.some((x) => x.includes("Sweep draft"))).toBe(false);
    expect(await titles(await rev())).not.toContain("Overdue: Sweep late"); // only the people who owe the work
    const again = await sweepDeadlines(owner.db, { today: "2027-03-10" });
    expect(again.sent).toBe(0);
    expect((await listNotifications(await con())).filter((n) => n.title === "Overdue: Sweep late")).toHaveLength(1);
    const nextDay = await sweepDeadlines(owner.db, { today: "2027-03-11" }); // overdue repeats daily, "due soon" does not
    expect(nextDay.sent).toBeGreaterThanOrEqual(1);
    expect((await listNotifications(await con())).filter((n) => n.title === "Overdue: Sweep late")).toHaveLength(2);
    expect((await listNotifications(await con())).filter((n) => n.title.startsWith("Due in") && n.title.includes("Sweep soon"))).toHaveLength(1);
    expect(soon.id && late.id && draft.id).toBeTruthy();
  });
});

describe("administration", () => {
  it("tenant AI switches: tenant admins only, audited, and turning AI off forces external use off", async () => {
    expect(await getTenantSettings(await adm())).toMatchObject({ aiExtractionEnabled: false, externalLlmEnabled: false });
    await expect(updateTenantSettings(await mgr(), { aiExtractionEnabled: true })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getTenantSettings(await mgr())).rejects.toBeInstanceOf(ForbiddenError);
    await updateTenantSettings(await adm(), { aiExtractionEnabled: true, externalLlmEnabled: true });
    expect(await getTenantSettings(await adm())).toMatchObject({ aiExtractionEnabled: true, externalLlmEnabled: true });
    await updateTenantSettings(await adm(), { aiExtractionEnabled: false });
    expect(await getTenantSettings(await adm())).toMatchObject({ aiExtractionEnabled: false, externalLlmEnabled: false });
    const ev = (await listAudit(await aud())).rows.filter((e) => e.action === "tenant.settings_updated");
    expect(ev.length).toBe(2); expect(ev[0]!.before).toMatchObject({ aiExtractionEnabled: true, externalLlmEnabled: true });
    await expect(updateTenantSettings(await adm(), {})).rejects.toThrow();
  });

  it("creates, edits and deactivates users with an audit trail; deactivation takes effect immediately", async () => {
    const dir = await listUsers(await adm());
    const { id } = await createUser(await adm(), { email: "New.Hire@Example.test", name: "New Hire", role: "contributor", departmentId: dir.departments[0]!.id });
    expect((await listUsers(await adm())).users.find((u) => u.id === id)).toMatchObject({ email: "new.hire@example.test", role: "contributor", isActive: true });
    await expect(createUser(await adm(), { email: "new.hire@example.test", name: "Dup", role: "contributor" })).rejects.toBeInstanceOf(ConflictError);
    await updateUser(await adm(), id, { role: "tax_reviewer", title: "Reviewer" });
    expect((await loadSession(app.db, A.tenantId, id))!.role).toBe("tax_reviewer");
    await updateUser(await adm(), id, { isActive: false });
    expect(await loadSession(app.db, A.tenantId, id)).toBeNull();
    const actions = (await listAudit(await aud(), { entityType: "user" })).rows.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["user.created", "user.updated", "user.deactivated"]));
    for (const c of [await mgr(), await rev(), await con()]) {
      await expect(createUser(c, { email: "x@y.test", name: "Xx", role: "contributor" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listUsers(c)).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(updateUser(await adm(), randomUUID(), { name: "Ghost User" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateUser(await ctxFor(B, B.users.admin), A.users.contributor, { name: "Hijacked" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("surfaces the database's own rules as clear messages (no self-lockout)", async () => {
    await expect(updateUser(await adm(), A.users.admin, { role: "contributor" })).rejects.toThrow(/cannot change your own role/i);
    await expect(updateUser(await adm(), A.users.admin, { isActive: false })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("editing drafts", () => {
  const body = (title: string, items: string[], assignees: object[] = []) => ({ title, taxYear: 2025, dueDate: "2027-05-01", priority: "high", items: items.map((t) => ({ title: t, dataType: "other" as const })), assignees });
  it("replaces items and assignees, keeps the reference, and audits the before/after", async () => {
    const m = await mgr();
    const r = await createRequest(m, body("Draft to edit", ["Old item"], [{ type: "department", id: A.departmentId }]));
    const edited = await updateDraftRequest(m, r.id, body("Draft edited", ["New one", "New two"], [{ type: "user", id: A.users.contributor }]));
    expect(edited.reference).toBe(r.reference);
    const d = await getRequestDetail(m, r.id);
    expect(d).toMatchObject({ title: "Draft edited", priority: "high", status: "draft" });
    expect(d.items.map((i) => i.title)).toEqual(["New one", "New two"]);
    expect(d.assignees).toEqual([expect.objectContaining({ type: "user", id: A.users.contributor })]);
    expect(d.can.edit).toBe(true);
    const ev = (await listAudit(await aud(), { requestRef: r.id })).rows.find((e) => e.action === "request.updated")!;
    expect(ev.before).toMatchObject({ title: "Draft to edit", items: ["Old item"], assignees: 1 }); expect(ev.after).toMatchObject({ title: "Draft edited", items: ["New one", "New two"] });
  });

  it("refuses published requests, other roles, other tenants, bad input, and drafts whose items already have comments", async () => {
    const m = await mgr();
    const pub = await openRequest("Already published");
    await expect(updateDraftRequest(m, pub.id, body("Nope nope", ["x item"], [{ type: "department", id: A.departmentId }]))).rejects.toBeInstanceOf(InvalidTransitionError);
    expect((await getRequestDetail(m, pub.id)).can.edit).toBe(false);
    const draft = await createRequest(m, body("Guarded draft", ["Keep me"], []));
    for (const c of [await rev(), await con(), await aud()]) await expect(updateDraftRequest(c, draft.id, body("Hijack me", ["y item"]))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateDraftRequest(await ctxFor(B, B.users.manager), draft.id, body("Cross tenant", ["z item"]))).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateDraftRequest(m, draft.id, { title: "x" })).rejects.toThrow();
    const itemId = (await getRequestDetail(m, draft.id)).items[0]!.id;
    await withTenant(owner.db, { tenantId: A.tenantId }, (tx) => tx.insert(comments).values({ tenantId: A.tenantId, requestId: draft.id, itemId, authorId: A.users.manager, body: "note on the item" }));
    await expect(updateDraftRequest(m, draft.id, body("Guarded draft", ["Different"]))).rejects.toThrow(/already has comments/);
    expect((await getRequestDetail(m, draft.id)).items[0]!.title).toBe("Keep me"); // the failed edit rolled back completely
  });
});

describe("audit export", () => {
  const VERIFY = resolve(__dirname, "../../../scripts/verify-audit-export.mjs");
  const verify = (obj: unknown) => {
    const f = join(mkdtempSync(join(tmpdir(), "audit-")), "export.json");
    writeFileSync(f, JSON.stringify(obj));
    try { return { code: 0, out: execFileSync("node", [VERIFY, f], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
    catch (e: any) { return { code: e.status as number, out: String(e.stderr) }; }
  };

  it("is available to audit roles only, verified server-side, and is itself audited", async () => {
    for (const c of [await rev(), await con(), await mgr().then((x) => x)]) if (c.session.role !== "tax_manager") await expect(exportAudit(c)).rejects.toBeInstanceOf(ForbiddenError);
    const exp = await exportAudit(await aud());
    expect(exp.meta).toMatchObject({ complete: true, chain: { ok: true }, exportedBy: "Al Auditor" });
    expect(exp.meta.count).toBe(exp.events.length); expect(exp.events.length).toBeGreaterThan(20);
    expect(exp.events[0]).toHaveProperty("canonical");
    expect((await listAudit(await aud(), { actionPrefix: "audit." })).rows.some((e) => e.action === "audit.exported")).toBe(true);
    expect(exp.events.some((e) => e.action === "audit.exported" && e.summary === `Exported ${exp.meta.count} audit event(s)`)).toBe(false); // not part of itself
    const filtered = await exportAudit(await aud(), { actionPrefix: "request." });
    expect(filtered.events.every((e) => String(e.action).startsWith("request."))).toBe(true);
  });

  it("verifies offline with nothing but SHA-256, and catches tampering, truncation and reordering", async () => {
    const exp = JSON.parse(JSON.stringify(await exportAudit(await aud())));
    expect(verify(exp)).toMatchObject({ code: 0, out: expect.stringContaining("contiguous from the genesis hash") });

    const edited = JSON.parse(JSON.stringify(exp)); edited.events[5].summary = "Nothing to see here";
    expect(verify(edited)).toMatchObject({ code: 1, out: expect.stringContaining("visible fields") });
    const forged = JSON.parse(JSON.stringify(exp)); forged.events[7].hash = "f".repeat(64);
    expect(verify(forged).code).toBe(1);
    const recomputed = JSON.parse(JSON.stringify(exp)); recomputed.events[3].canonical = recomputed.events[3].canonical.replace(/"([a-z]+\.[a-z_]+)"/, '"x.$1"');
    expect(verify(recomputed).code).toBe(1);
    const removed = JSON.parse(JSON.stringify(exp)); removed.events.splice(10, 1);
    expect(verify(removed)).toMatchObject({ code: 1, out: expect.stringContaining("gap in sequence") });
    const reordered = JSON.parse(JSON.stringify(exp)); [reordered.events[4], reordered.events[5]] = [reordered.events[5], reordered.events[4]];
    expect(verify(reordered).code).toBe(1);
    expect(verify({ nope: true }).code).toBe(2);
    expect(verify(await exportAudit(await aud(), { actionPrefix: "request." }))).toMatchObject({ code: 0, out: expect.stringContaining("filtered export") });
  });

  it("neutralises spreadsheet formulas in the CSV (cells a user controls) and keeps quoting correct", async () => {
    // A user whose NAME begins with a formula character becomes the actor label of everything they do.
    const evil = randomUUID();
    await withTenant(owner.db, { tenantId: A.tenantId }, (tx) => tx.insert(users).values({ id: evil, tenantId: A.tenantId, email: `evil@${A.slug}.test`, name: "=HYPERLINK(\"http://evil\",\"x\")", role: "tax_manager" }));
    await createRequest(await ctxFor(A, evil), { title: 'Quotes, "commas"\nand lines', taxYear: 2025, dueDate: "2027-01-01", items: [], assignees: [] });
    const csv = toCsv(await exportAudit(await aud(), { actionPrefix: "request.created" }));
    expect(csv.split("\r\n")[0]).toBe("seq,occurred_at,actor_type,actor_label,action,entity_type,entity_id,request_ref,summary,before,after,prev_hash,hash,canonical");
    expect(csv).toMatch(/,"'=HYPERLINK\(""http:\/\/evil""/);   // defused with an apostrophe, and the embedded quotes doubled
    expect(csv).not.toMatch(/(^|,)"?=HYPERLINK/m);              // no cell starts with a live formula
    expect(csv).toContain('""commas""');
  });
});
