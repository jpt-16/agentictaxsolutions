import ExcelJS from "exceljs";
import { parse } from "csv-parse/sync";
import type { FileKind } from "./validate";

export const PREVIEW_MAX_ROWS = 200;
export const PREVIEW_MAX_COLS = 30;

export interface SheetPreview {
  sheets: { name: string; rows: number; cols: number }[];
  active: string;
  rows: string[][];
  totalRows: number;
  totalCols: number;
  truncatedRows: boolean;
  truncatedCols: boolean;
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as any;
    if ("result" in o) return o.result === undefined || o.result === null ? "" : cellText(o.result); // formulas: cached value only, never evaluated
    if ("richText" in o) return o.richText.map((r: any) => r.text).join("");
    if ("text" in o) return String(o.text);
    if ("error" in o) return String(o.error);
    return "";
  }
  return String(v);
}

/** Read-only preview. Formulas show their cached result and are never evaluated; everything is returned as plain text. */
export async function previewSpreadsheet(bytes: Buffer, kind: FileKind, sheet?: string): Promise<SheetPreview> {
  if (kind === "csv") {
    const text = bytes.toString("utf8").replace(/^﻿/, "");
    const all = parse(text, { relax_column_count: true, skip_empty_lines: true, relax_quotes: true }) as string[][];
    const totalCols = all.reduce((m, r) => Math.max(m, r.length), 0);
    return {
      sheets: [{ name: "CSV", rows: all.length, cols: totalCols }], active: "CSV",
      rows: all.slice(0, PREVIEW_MAX_ROWS).map((r) => r.slice(0, PREVIEW_MAX_COLS).map(String)),
      totalRows: all.length, totalCols, truncatedRows: all.length > PREVIEW_MAX_ROWS, truncatedCols: totalCols > PREVIEW_MAX_COLS,
    };
  }
  if (kind !== "xlsx") throw new Error("Preview is only available for spreadsheets.");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  const sheets = wb.worksheets.map((w) => ({ name: w.name, rows: w.actualRowCount, cols: w.actualColumnCount }));
  if (sheets.length === 0) return { sheets, active: "", rows: [], totalRows: 0, totalCols: 0, truncatedRows: false, truncatedCols: false };
  const ws = wb.worksheets.find((w) => w.name === sheet) ?? wb.worksheets[0]!;
  const totalRows = ws.rowCount, totalCols = ws.columnCount;
  const rows: string[][] = [];
  for (let r = 1; r <= Math.min(totalRows, PREVIEW_MAX_ROWS); r++) {
    const row = ws.getRow(r);
    const out: string[] = [];
    for (let c = 1; c <= Math.min(totalCols, PREVIEW_MAX_COLS); c++) out.push(cellText(row.getCell(c).value));
    rows.push(out);
  }
  return { sheets, active: ws.name, rows, totalRows, totalCols, truncatedRows: totalRows > PREVIEW_MAX_ROWS, truncatedCols: totalCols > PREVIEW_MAX_COLS };
}
