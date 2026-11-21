/**
 * Hostile-input sweep over the service layer (checklist: empty, huge and weird inputs; wrong types; missing fields; quotes;
 * <script>; negative numbers; decimals where integers are expected; malformed ids). Every call must either succeed or fail with a
 * CLEAN domain/validation error. A raw database error, TypeError or crash is a finding: it is a 500 for the user and noise or worse
 * in the logs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type Connection } from "@taxops/db";
import { createTestTenant, TEST_APP_URL, TEST_OWNER_URL, type TestTenant } from "@taxops/db/src/testing";
import {
  addComment, createRequest, createTemplateFromRequest, createUser, getRequestDetail, listAudit, listRequests, loadSession, publishRequest, reviewItem,
  submitItem, updateDraftRequest, updateRule, updateTenantSettings, updateUser, type ServiceContext,
} from "./index";

let owner: Connection, app: Connection, A: TestTenant;
const ctxFor = async (userId: string): Promise<ServiceContext> => ({ db: app.db, session: (await loadSession(app.db, A.tenantId, userId))! });

const NASTY: unknown[] = [
  "", " ", "   ", "a".repeat(10_000), "a".repeat(250_000), "😀🧾".repeat(300), "'; drop table users; --", `" OR 1=1 --`, "<script>alert(1)</script>", `"><img src=x onerror=alert(1)>`,
  "\u0000", "before\u0000after", "‮evil", "%s%s%s%n", "${7*7}", "{{7*7}}", "../../etc/passwd", "=cmd|' /C calc'!A0", "-1", "1e999", "NaN", "0x1F", "2025-13-45", "9999-12-31", "0000-00-00", "2027-02-30",
  -1, 0, 1.5, 2 ** 53, -(2 ** 53), Number.NaN, Infinity, null, undefined, true, false, [], {}, [1, 2, 3], { a: 1 }, "__proto__", "constructor",
];
const MALFORMED_IDS: unknown[] = ["", "not-a-uuid", "1' OR '1'='1", "00000000-0000-0000-0000-00000000000", "00000000-0000-0000-0000-0000000000000", "ZZZZZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZZZZZZZZZ", "a".repeat(5000), "\u0000", 123, null, undefined, {}, []];

const CLEAN = new Set(["ZodError", "ForbiddenError", "NotFoundError", "InvalidTransitionError", "ConflictError", "UploadRejectedError"]);
const RAW = /Failed query|invalid input syntax|violates|syntax error|duplicate key|out of range|invalid byte sequence|Cannot read|is not a function|undefined is not|is not iterable/i;
const findings = new Map<string, string>();

async function attempt(label: string, fn: () => Promise<unknown>) {
  try { await fn(); } catch (e) {
    const name = (e as Error)?.name ?? typeof e, msg = String((e as Error)?.message ?? e);
    let deep = ""; for (let c: any = e; c; c = c.cause) deep += `${c.message} | `;
    if (!CLEAN.has(name) || RAW.test(msg)) findings.set(label, `${name}: ${(deep || msg).replace(/\s+/g, " ").slice(0, 140)}`);
  }
}
/** Replace one field at a time with each hostile value, and also delete it. Untouched fields keep their valid baseline. */
async function sweep(name: string, base: Record<string, any>, call: (v: any) => Promise<unknown>, keys = Object.keys(base)) {
  for (const k of keys) {
    for (const v of NASTY) await attempt(`${name}.${k} = ${JSON.stringify(v)?.slice(0, 30) ?? String(v)}`, () => call({ ...base, [k]: v }));
    const { [k]: _gone, ...rest } = base; await attempt(`${name}.${k} missing`, () => call(rest));
  }
  for (const v of NASTY.slice(0, 12)) await attempt(`${name} whole body = ${JSON.stringify(v)?.slice(0, 20)}`, () => call(v));
  await attempt(`${name} + __proto__`, () => call(JSON.parse(`{"__proto__": {"role": "tenant_admin"}, "x": 1}`)));
}

beforeAll(async () => { owner = connect(TEST_OWNER_URL, { max: 4 }); app = connect(TEST_APP_URL, { max: 8 }); A = await createTestTenant(owner, "fzz"); });
afterAll(async () => { await owner.close(); await app.close(); });

describe("hostile inputs never cause a raw failure", () => {
  it("request creation and editing", async () => {
    const mgr = await ctxFor(A.users.manager);
    const base = { title: "A valid title", description: "d", taxYear: 2025, dueDate: "2027-01-01", priority: "medium", items: [{ title: "Item one", description: "", dataType: "other", required: true }], assignees: [{ type: "department", id: A.departmentId }] };
    await sweep("createRequest", base, (v) => createRequest(mgr, v));
    for (const k of ["title", "description", "dataType", "required"]) for (const v of NASTY) await attempt(`createRequest.items[0].${k} = ${JSON.stringify(v)?.slice(0, 20)}`, () => createRequest(mgr, { ...base, items: [{ ...base.items[0], [k]: v }] }));
    for (const v of NASTY) await attempt(`createRequest.items = ${JSON.stringify(v)?.slice(0, 20)}`, () => createRequest(mgr, { ...base, items: v }));
    for (const v of NASTY) await attempt(`createRequest.assignees = ${JSON.stringify(v)?.slice(0, 20)}`, () => createRequest(mgr, { ...base, assignees: v }));
    await attempt("createRequest 500 items", () => createRequest(mgr, { ...base, items: Array.from({ length: 500 }, (_, i) => ({ ...base.items[0], title: `Item ${i} here` })) }));
    const draft = await createRequest(mgr, base);
    await sweep("updateDraftRequest", base, (v) => updateDraftRequest(mgr, draft.id, v));
    for (const id of MALFORMED_IDS) { await attempt(`updateDraftRequest id=${JSON.stringify(id)?.slice(0, 20)}`, () => updateDraftRequest(mgr, id as string, base)); await attempt(`getRequestDetail id=${JSON.stringify(id)?.slice(0, 20)}`, () => getRequestDetail(mgr, id as string)); await attempt(`publishRequest id=${JSON.stringify(id)?.slice(0, 20)}`, () => publishRequest(mgr, id as string)); }
  }, 600_000);

  it("comments, submissions and reviews", async () => {
    const mgr = await ctxFor(A.users.manager), con = await ctxFor(A.users.contributor), rev = await ctxFor(A.users.reviewer);
    const r = await createRequest(mgr, { title: "Fuzz target", taxYear: 2025, dueDate: "2027-01-01", items: [{ title: "Item one", dataType: "other" }], assignees: [{ type: "department", id: A.departmentId }] });
    await publishRequest(mgr, r.id);
    const itemId = (await getRequestDetail(mgr, r.id)).items[0]!.id;
    await sweep("addComment", { body: "hello", itemId }, (v) => addComment(con, r.id, v));
    await sweep("submitItem", { note: "a note" }, (v) => submitItem(con, itemId, v));
    await sweep("reviewItem", { decision: "approved", rationale: "ok" }, (v) => reviewItem(rev, itemId, v));
    for (const id of MALFORMED_IDS) { await attempt(`addComment requestId=${JSON.stringify(id)?.slice(0, 20)}`, () => addComment(con, id as string, { body: "x" })); await attempt(`submitItem itemId=${JSON.stringify(id)?.slice(0, 20)}`, () => submitItem(con, id as string, { note: "x" })); await attempt(`reviewItem itemId=${JSON.stringify(id)?.slice(0, 20)}`, () => reviewItem(rev, id as string, { decision: "approved" })); }
  }, 600_000);

  it("administration, rules, templates and search filters", async () => {
    const adm = await ctxFor(A.users.admin), mgr = await ctxFor(A.users.manager), aud = await ctxFor(A.users.auditor);
    await sweep("createUser", { email: "fuzz@example.test", name: "Fuzz User", role: "contributor", title: "T" }, (v) => createUser(adm, { ...v, email: v?.email === "fuzz@example.test" ? `f${Math.random().toString(36).slice(2)}@example.test` : v?.email }));
    await sweep("updateUser", { title: "x", role: "contributor", isActive: true }, (v) => updateUser(adm, A.users.contributor, v));
    await sweep("updateTenantSettings", { aiExtractionEnabled: true, externalLlmEnabled: false, llmDailyCallLimit: 50 }, (v) => updateTenantSettings(adm, v));
    await sweep("updateRule", { enabled: true, params: { tolerance: "1" } }, (v) => updateRule(mgr, "tb_footing", v));
    for (const id of MALFORMED_IDS) await attempt(`updateRule id=${JSON.stringify(id)?.slice(0, 20)}`, () => updateRule(mgr, id as string, { enabled: true }));
    const r = await createRequest(mgr, { title: "Template source", taxYear: 2025, dueDate: "2027-01-01", items: [{ title: "Item one", dataType: "other" }], assignees: [] });
    for (const v of NASTY) await attempt(`createTemplateFromRequest name=${JSON.stringify(v)?.slice(0, 20)}`, () => createTemplateFromRequest(mgr, r.id, v));
    await sweep("listRequests", { q: "x", status: "open", limit: 10, offset: 0 }, (v) => listRequests(mgr, v));
    await sweep("listAudit", { actionPrefix: "item.", entityType: "request", requestRef: "00000000-0000-4000-8000-000000000000", q: "x", limit: 10, offset: 0 }, (v) => listAudit(aud, v));
  }, 600_000);

  it("reports every raw failure at once (this must be empty)", () => {
    const lines = [...findings].map(([k, v]) => `${k}\n      -> ${v}`);
    expect(lines.join("\n"), `${lines.length} input(s) caused a raw failure instead of a clean validation error`).toBe("");
  });
});
