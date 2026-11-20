import ExcelJS from "exceljs";

/** Generates FICTIONAL workbooks for the demo. All figures are invented. */
export interface SeedWorkbook {
  kind: "tb" | "intercompany" | "fixed_assets" | "transfer_pricing" | "rd";
  fileName: string;
  sheets: string[];
  /** One sheet whose debits do not equal credits, so Phase 4's validation agent has something real to find. */
  unbalancedSheet?: string;
}
type Row = (string | number)[];

// Small deterministic PRNG so every reseed produces the same demo numbers.
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }
const hash = (t: string) => [...t].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

const ACCOUNTS: [string, string, "D" | "C"][] = [
  ["1000", "Cash and cash equivalents", "D"], ["1100", "Trade receivables", "D"], ["1200", "Intercompany receivables", "D"], ["1300", "Inventory", "D"],
  ["1500", "Property, plant and equipment", "D"], ["1590", "Accumulated depreciation", "C"], ["2000", "Trade payables", "C"], ["2100", "Accrued liabilities", "C"],
  ["2200", "Intercompany payables", "C"], ["2500", "Income tax payable", "C"], ["3000", "Share capital", "C"], ["3100", "Retained earnings", "C"],
  ["4000", "Revenue", "C"], ["5000", "Cost of sales", "D"], ["6000", "Salaries and wages", "D"], ["6100", "Depreciation expense", "D"], ["7000", "Interest expense", "D"], ["8000", "Income tax expense", "D"],
];

function trialBalance(sheet: string, unbalanced: boolean): Row[] {
  const r = rng(hash(sheet));
  const amt = (lo: number, hi: number) => Math.round((r() * (hi - lo) + lo) * 1000);
  const v: Record<string, number> = {
    "1000": amt(200, 900), "1100": amt(600, 1800), "1200": amt(300, 1200), "1300": amt(400, 1400), "1500": amt(2500, 6000), "1590": amt(800, 1800),
    "2000": amt(500, 1200), "2100": amt(200, 700), "2200": amt(250, 900), "2500": amt(80, 400), "3000": amt(900, 1500),
    "5000": amt(1800, 3200), "6000": amt(900, 1900), "6100": amt(250, 600), "7000": amt(60, 260),
  };
  // A plausible, profitable entity: revenue exceeds costs by 10-20%, tax is 25% of pre-tax profit.
  const costs = v["5000"]! + v["6000"]! + v["6100"]! + v["7000"]!;
  v["4000"] = Math.round(costs * (1.1 + r() * 0.1));
  v["8000"] = Math.round((v["4000"] - costs) * 0.25);
  // Retained earnings is the balancing figure so a correct TB foots exactly.
  const debitSide = (["1000", "1100", "1200", "1300", "1500", "5000", "6000", "6100", "7000", "8000"] as const).reduce((n, k) => n + v[k]!, 0);
  const creditSide = (["1590", "2000", "2100", "2200", "2500", "3000", "4000"] as const).reduce((n, k) => n + v[k]!, 0);
  const plug = debitSide - creditSide; // positive: debits exceed credits, so retained earnings is the missing CREDIT
  const rows: Row[] = [["Account", "Description", "Debit", "Credit"]];
  for (const [code, name, side] of ACCOUNTS) {
    if (code === "3100") rows.push([code, name, plug < 0 ? -plug : 0, plug > 0 ? plug : 0]);
    else {
      // One entity's tax line carries an input error so the demo has a real finding to detect later.
      const x = v[code]! + (unbalanced && code === "8000" ? 12_450 : 0);
      rows.push([code, name, side === "D" ? x : 0, side === "C" ? x : 0]);
    }
  }
  const dSum = rows.slice(1).reduce((n, x) => n + Number(x[2]), 0), cSum = rows.slice(1).reduce((n, x) => n + Number(x[3]), 0);
  rows.push(["", "Total", dSum, cSum]);
  return rows;
}

function table(kind: SeedWorkbook["kind"], sheet: string): Row[] {
  const r = rng(hash(sheet + kind));
  const n = (lo: number, hi: number) => Math.round(r() * (hi - lo) + lo);
  switch (kind) {
    case "intercompany": return [["Counterparty", "Type", "Currency", "Balance (local)", "Confirmed"], ...["Northwind France SAS", "Northwind UK Ltd.", "Northwind Netherlands B.V."].map((c) => [c, "Trade", "EUR", n(20_000, 400_000), "Yes"])];
    case "fixed_assets": return [["Asset class", "Opening cost", "Additions", "Disposals", "Closing cost", "Accum. depreciation"], ...["Buildings", "Machinery", "Vehicles", "IT equipment", "Leasehold improvements"].map((c) => { const o = n(500_000, 9_000_000), a = n(0, 900_000), d = n(0, 250_000); return [c, o, a, d, o + a - d, n(100_000, 3_000_000)]; })];
    case "transfer_pricing": return [["Service line", "Cost base", "Markup %", "Charge"], ...["IT support", "Finance shared services", "HR administration", "Legal"].map((c) => { const b = n(150_000, 1_200_000); return [c, b, 7, Math.round(b * 1.07)]; })];
    case "rd": return [["Project", "Qualified wages", "Contractors", "Supplies"], ...["Project Atlas", "Project Borealis", "Project Cedar", "Project Delta"].map((c) => [c, n(200_000, 1_500_000), n(0, 300_000), n(5_000, 90_000)])];
    default: return [["Item", "Amount"]];
  }
}

export async function makeSeedWorkbook(spec: SeedWorkbook): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Northwind Holdings (fictional demo)";
  for (const name of spec.sheets) {
    const ws = wb.addWorksheet(name.slice(0, 31));
    const rows = spec.kind === "tb" ? trialBalance(name, spec.unbalancedSheet === name) : table(spec.kind, name);
    rows.forEach((row) => ws.addRow(row));
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((c, i) => { c.width = i === 1 ? 34 : 16; });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
