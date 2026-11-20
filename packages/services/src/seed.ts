import { randomUUID } from "node:crypto";
import { todayIso, type DataType, type Role } from "@taxops/core";
import { departments, legalEntities, tenants, users, withTenant, type Connection } from "@taxops/db";
import { type ServiceContext } from "./context";
import { loadSession } from "./auth";
import { makeSeedWorkbook } from "./seed-files";
import { submitWithFiles, type FileDeps } from "./files/upload";
import { createRequest, getRequestDetail, publishRequest, reviewItem, submitItem, closeRequest, addComment } from "./requests";

/**
 * 100% FICTIONAL demo data. "Northwind Holdings" is an invented multinational; every person, entity and
 * figure here is made up. Do not load real corporate data into this system during development.
 */
const ENTITIES = [
  ["NWH", "Northwind Holdings Inc.", "US", "USD"], ["NWA", "Northwind Americas LLC", "US", "USD"],
  ["NWC", "Northwind Canada Ltd.", "CA", "CAD"], ["NWB", "Northwind do Brasil Ltda.", "BR", "BRL"],
  ["NWU", "Northwind UK Ltd.", "GB", "GBP"], ["NWI", "Northwind Ireland DAC", "IE", "EUR"],
  ["NWG", "Northwind GmbH", "DE", "EUR"], ["NWF", "Northwind France SAS", "FR", "EUR"],
  ["NWN", "Northwind Netherlands B.V.", "NL", "EUR"], ["NWS", "Northwind Singapore Pte. Ltd.", "SG", "SGD"],
  ["NWJ", "Northwind Japan K.K.", "JP", "JPY"], ["NWP", "Northwind Australia Pty Ltd", "AU", "AUD"],
] as const;

const DEPARTMENTS = [
  ["FIN", "Corporate Finance"], ["TRE", "Treasury"], ["ACA", "Accounting – Americas"], ["ACE", "Accounting – EMEA"],
  ["ACP", "Accounting – APAC"], ["FAS", "Fixed Assets"], ["RND", "Research & Development"], ["PAY", "Payroll & HR"],
] as const;

type P = { key: string; name: string; title: string; role: Role; dept?: string; entity?: string };
const PEOPLE: P[] = [
  { key: "admin", name: "Priya Raman", title: "Tenant Administrator", role: "tenant_admin" },
  { key: "marcus", name: "Marcus Hale", title: "Director of Tax", role: "tax_manager" },
  { key: "elena", name: "Elena Ruiz", title: "Senior Tax Manager, International", role: "tax_manager" },
  { key: "tomas", name: "Tomas Berg", title: "Tax Reviewer", role: "tax_reviewer" },
  { key: "naomi", name: "Naomi Clarke", title: "Tax Reviewer", role: "tax_reviewer" },
  { key: "grace", name: "Grace Okafor", title: "Internal Audit", role: "auditor" },
  { key: "sam", name: "Sam Whitfield", title: "Senior Accountant", role: "contributor", dept: "ACA", entity: "NWA" },
  { key: "jack", name: "Jack Turner", title: "R&D Finance Partner", role: "contributor", dept: "RND", entity: "NWA" },
  { key: "ryan", name: "Ryan O'Neill", title: "Treasury Analyst", role: "contributor", dept: "TRE", entity: "NWH" },
  { key: "aisha", name: "Aisha Khan", title: "Fixed Asset Accountant", role: "contributor", dept: "FAS", entity: "NWH" },
  { key: "lena", name: "Lena Fischer", title: "Financial Controller, Germany", role: "contributor", dept: "ACE", entity: "NWG" },
  { key: "chloe", name: "Chloé Martin", title: "Accounting Manager, France", role: "contributor", dept: "ACE", entity: "NWF" },
  { key: "oliver", name: "Oliver Grant", title: "Financial Controller, UK", role: "contributor", dept: "ACE", entity: "NWU" },
  { key: "fiona", name: "Fiona Byrne", title: "Finance Manager, Ireland", role: "contributor", dept: "ACE", entity: "NWI" },
  { key: "hiro", name: "Hiro Tanaka", title: "Accounting Lead, Japan", role: "contributor", dept: "ACP", entity: "NWJ" },
  { key: "mei", name: "Mei Lin Tan", title: "Finance Manager, Singapore", role: "contributor", dept: "ACP", entity: "NWS" },
  { key: "diego", name: "Diego Alvarez", title: "Controller, Brazil", role: "contributor", dept: "ACA", entity: "NWB" },
];

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export async function seedDemo(owner: Connection, app: Connection, opts: { slug?: string; today?: string; files?: FileDeps } = {}) {
  const slug = opts.slug ?? "northwind";
  const today = opts.today ?? todayIso();
  const tenantId = randomUUID();
  const entityId = new Map<string, string>(), deptId = new Map<string, string>(), userId = new Map<string, string>();

  await withTenant(owner.db, { tenantId }, async (tx) => {
    await tx.insert(tenants).values({ id: tenantId, name: "Northwind Holdings (fictional demo)", slug });
    for (const [code, name, country, currency] of ENTITIES) {
      const id = randomUUID(); entityId.set(code, id);
      await tx.insert(legalEntities).values({ id, tenantId, code, name, country, currency });
    }
    for (const [code, name] of DEPARTMENTS) {
      const id = randomUUID(); deptId.set(code, id);
      await tx.insert(departments).values({ id, tenantId, code, name });
    }
    for (const p of PEOPLE) {
      const id = randomUUID(); userId.set(p.key, id);
      await tx.insert(users).values({
        id, tenantId, name: p.name, title: p.title, role: p.role,
        email: `${p.name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z ]/g, "").replace(/ +/g, ".")}@northwind.example`,
        departmentId: p.dept ? deptId.get(p.dept)! : null, entityId: p.entity ? entityId.get(p.entity)! : null,
      });
    }
  });

  const ctx = async (key: string): Promise<ServiceContext> => {
    const session = await loadSession(app.db, tenantId, userId.get(key)!);
    if (!session) throw new Error(`no session for ${key}`);
    return { db: app.db, session };
  };
  const dept = (c: string) => ({ type: "department" as const, id: deptId.get(c)! });
  const ent = (c: string) => ({ type: "entity" as const, id: entityId.get(c)! });
  const usr = (k: string) => ({ type: "user" as const, id: userId.get(k)! });
  const item = (title: string, dataType: DataType, description = "") => ({ title, dataType, description, required: true });

  async function make(by: string, input: Parameters<typeof createRequest>[1] & object, publish = true) {
    const m = await ctx(by);
    const r = await createRequest(m, input);
    if (publish) await publishRequest(m, r.id);
    return { ...r, items: publish ? (await getRequestDetail(m, r.id)).items : [] };
  }
  // With file deps, submissions carry a generated (fictional) workbook so the viewer has something real to show.
  const submit = async (who: string, itemId: string, note: string, wb?: Parameters<typeof makeSeedWorkbook>[0]) => {
    const c = await ctx(who);
    if (wb && opts.files) return submitWithFiles(c, opts.files, itemId, { note }, [{ name: wb.fileName, bytes: await makeSeedWorkbook(wb) }]);
    return submitItem(c, itemId, { note });
  };
  const approve = async (who: string, itemId: string) => reviewItem(await ctx(who), itemId, { decision: "approved", rationale: "" });
  const reject = async (who: string, itemId: string, why: string) => reviewItem(await ctx(who), itemId, { decision: "changes_requested", rationale: why });

  // 1. Year-end trial balances: broad, in progress
  const tb = await make("marcus", {
    title: "FY2025 year-end trial balances – all entities", taxYear: 2025, dueDate: addDays(today, 21), priority: "high",
    description: "Provide the final, post-close trial balance for each legal entity in local currency, mapped to the group chart of accounts.",
    items: [
      item("Trial balance – Americas entities", "trial_balance", "NWH, NWA, NWC and NWB in local currency."),
      item("Trial balance – EMEA entities", "trial_balance", "NWU, NWI, NWG, NWF and NWN in local currency."),
      item("Trial balance – APAC entities", "trial_balance", "NWS, NWJ and NWP in local currency."),
      item("Chart of accounts mapping confirmation", "narrative", "Confirm no new local accounts were added after the Q3 mapping."),
    ],
    assignees: [dept("ACA"), dept("ACE"), dept("ACP")],
  });
  await submit("sam", tb.items[0]!.id, "Americas TBs attached (USD/CAD/BRL), post-close as of 31 Dec.", { kind: "tb", fileName: "FY2025_TB_Americas.xlsx", sheets: ["NWH – USD", "NWA – USD", "NWC – CAD", "NWB – BRL"] });
  await approve("tomas", tb.items[0]!.id);
  await submit("lena", tb.items[1]!.id, "EMEA consolidated TB workbook, one tab per entity.", { kind: "tb", fileName: "FY2025_TB_EMEA.xlsx", sheets: ["NWU – GBP", "NWI – EUR", "NWG – EUR", "NWF – EUR", "NWN – EUR"], unbalancedSheet: "NWF – EUR" });
  await submit("mei", tb.items[2]!.id, "APAC TBs – JPY and SGD, AUD pending bank rec.", { kind: "tb", fileName: "FY2025_TB_APAC.xlsx", sheets: ["NWS – SGD", "NWJ – JPY"] });
  await reject("naomi", tb.items[2]!.id, "AUD entity is missing; please include NWP or confirm it will follow separately.");
  await addComment(await ctx("mei"), tb.id, { body: "NWP's bank rec closes Thursday – will resubmit with all three entities then." });

  // 2. Intercompany confirmations: OVERDUE and mostly stalled
  const ic = await make("elena", {
    title: "Q4 intercompany balance confirmations", taxYear: 2025, dueDate: addDays(today, -6), priority: "high",
    description: "Confirm intercompany receivable/payable balances and loan principal with counterparties as at quarter end.",
    items: [
      item("Intercompany loans – principal and accrued interest", "intercompany"),
      item("Intercompany trade balances – Germany/France/UK", "intercompany"),
      item("Management fee and royalty accruals", "intercompany"),
    ],
    assignees: [ent("NWG"), ent("NWF"), ent("NWU"), usr("ryan")],
  });
  await submit("lena", ic.items[1]!.id, "DE side confirmed; matches the counterparty statements.", { kind: "intercompany", fileName: "Q4_IC_Balances_DE.xlsx", sheets: ["Trade balances"] });
  await approve("tomas", ic.items[1]!.id);

  // 3. Fixed assets: fully approved, awaiting close
  const fa = await make("marcus", {
    title: "FY2025 fixed asset register roll-forward", taxYear: 2025, dueDate: addDays(today, 8), priority: "medium",
    items: [item("Fixed asset register – additions and disposals", "fixed_asset_register"), item("Tax vs book depreciation schedule", "fixed_asset_register")],
    assignees: [dept("FAS")],
  });
  for (const it of fa.items) { await submit("aisha", it.id, "Roll-forward attached with supporting invoices.", { kind: "fixed_assets", fileName: `FY2025_FA_${it.position === 1 ? "Rollforward" : "TaxVsBook"}.xlsx`, sheets: ["Register"] }); await approve("naomi", it.id); }
  await addComment(await ctx("marcus"), fa.id, { body: "Thanks Aisha – clean pack. Closing once the audit has seen it." });

  // 4. R&D credit: in review
  const rd = await make("elena", {
    title: "R&D tax credit – qualified research expenses (US)", taxYear: 2025, dueDate: addDays(today, 30), priority: "medium",
    items: [item("Qualified wages by project", "rd_credit"), item("Contract research and supplies", "rd_credit"), item("Project narratives", "narrative")],
    assignees: [dept("RND"), usr("jack")],
  });
  for (const it of rd.items) await submit("jack", it.id, "Submitted for review.", it.position === 3 ? undefined : { kind: "rd", fileName: it.position === 1 ? "QRE_Wages_by_Project.xlsx" : "QRE_Contract_Supplies.xlsx", sheets: ["QREs"] });

  // 5. Transfer pricing: changes requested
  const tp = await make("elena", {
    title: "Transfer pricing – intercompany service charges FY2025", taxYear: 2025, dueDate: addDays(today, 12), priority: "high",
    items: [item("Cost base and markup by service line", "transfer_pricing"), item("Benchmarking support", "transfer_pricing")],
    assignees: [ent("NWG"), ent("NWU"), ent("NWI")],
  });
  await submit("oliver", tp.items[0]!.id, "Cost base for UK shared services, 7% markup.", { kind: "transfer_pricing", fileName: "UK_SharedServices_CostBase.xlsx", sheets: ["Cost base"] });
  await reject("tomas", tp.items[0]!.id, "Cost base appears to include pass-through costs; please split them out.");

  // 6. Treasury: just opened
  await make("marcus", {
    title: "Withholding tax on cross-border interest and dividends", taxYear: 2025, dueDate: addDays(today, 18), priority: "medium",
    items: [item("Schedule of cross-border interest payments", "other"), item("Dividend distributions and treaty claims", "other")],
    assignees: [dept("TRE"), dept("FIN")],
  });

  // 7. Payroll: open, due very soon
  await make("elena", {
    title: "Expatriate and cross-border payroll data", taxYear: 2025, dueDate: addDays(today, 4), priority: "high",
    items: [item("Expatriate roster and workdays by jurisdiction", "other"), item("Equity compensation vesting summary", "other")],
    assignees: [dept("PAY")],
  });

  // 8. Closed, last year
  const ly = await make("marcus", {
    title: "FY2024 deferred tax roll-forward", taxYear: 2024, dueDate: addDays(today, -60), priority: "low",
    items: [item("Deferred tax asset/liability schedule", "narrative")], assignees: [dept("FIN"), dept("TRE")],
  });
  await submit("ryan", ly.items[0]!.id, "Final FY2024 DTA/DTL schedule.");
  await approve("tomas", ly.items[0]!.id);
  await closeRequest(await ctx("marcus"), ly.id);

  // 9 & 10. Drafts
  await make("marcus", {
    title: "FY2026 Q1 estimated tax payments – data pull", taxYear: 2026, dueDate: addDays(today, 45), priority: "medium",
    items: [item("YTD pre-tax income by entity", "trial_balance")], assignees: [dept("ACA")],
  }, false);
  await make("elena", {
    title: "Pillar Two safe-harbour data (draft scoping)", taxYear: 2026, dueDate: addDays(today, 60), priority: "low",
    description: "Scoping a data request for GloBE safe-harbour calculations. Items and assignees to be confirmed.",
    items: [], assignees: [],
  }, false);

  return { tenantId, slug };
}
