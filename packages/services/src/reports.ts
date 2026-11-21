import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { assertCan, daysUntil, isOverdue, REQUEST_STATUSES, type RequestStatus } from "@taxops/core";
import { extractedRows, files, proposals, recordAudit, requestItems, requests, users } from "@taxops/db";
import { auditActorOf, NotFoundError, scoped, todayOf, type ServiceContext, assertUuid } from "./context";

const FORMULA = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[-+]?\d+(\.\d+)?$/; // a bare number cannot be a formula, so negative amounts keep their sign
/** CSV with spreadsheet-formula neutralisation on every text cell, so an opened export can never execute anything. */
export function csvOf(columns: string[], rows: Record<string, unknown>[]): string {
  const cell = (v: unknown) => {
    let t = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
    if (typeof v === "string" && FORMULA.test(t) && !PLAIN_NUMBER.test(t)) t = "'" + t;
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}

export interface StatusReportRow {
  request_id: string; reference: string; title: string; tax_year: number; status: RequestStatus; priority: string; due_date: string; days_left: number; overdue: boolean;
  items_total: number; items_approved: number; items_submitted: number; published_at: string; closed_at: string; cycle_days: number | "";
}
export interface StatusReport {
  generatedAt: string;
  rows: StatusReportRow[];
  summary: {
    total: number; byStatus: Record<RequestStatus, number>; overdue: number; completionPct: number;
    closedCount: number; avgCycleDays: number | null; onTimePct: number | null;
  };
}

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");

/** Status of every request in the tenant. Roles with report.read already see all requests, so no assignment scoping applies. */
export async function requestStatusReport(ctx: ServiceContext): Promise<StatusReport> {
  assertCan(ctx.session.role, "report.read");
  const today = todayOf(ctx);
  return scoped(ctx, async (tx) => {
    const reqs = await tx.select().from(requests).orderBy(asc(requests.dueDate), asc(requests.reference));
    const items = reqs.length ? await tx.select({ requestId: requestItems.requestId, status: requestItems.status }).from(requestItems) : [];
    const rows: StatusReportRow[] = reqs.map((r) => {
      const its = items.filter((i) => i.requestId === r.id);
      const cycle = r.publishedAt && r.closedAt ? Math.max(0, Math.round((r.closedAt.getTime() - r.publishedAt.getTime()) / 86_400_000)) : "";
      return {
        request_id: r.id, reference: r.reference, title: r.title, tax_year: r.taxYear, status: r.status, priority: r.priority, due_date: r.dueDate,
        days_left: daysUntil(r.dueDate, today), overdue: isOverdue(r.dueDate, r.status, today),
        items_total: its.length, items_approved: its.filter((i) => i.status === "approved").length, items_submitted: its.filter((i) => i.status === "submitted").length,
        published_at: day(r.publishedAt), closed_at: day(r.closedAt), cycle_days: cycle,
      };
    });
    const byStatus = Object.fromEntries(REQUEST_STATUSES.map((s) => [s, 0])) as Record<RequestStatus, number>;
    for (const r of rows) byStatus[r.status]++;
    const itemsTotal = rows.reduce((n, r) => n + r.items_total, 0);
    const itemsApproved = rows.reduce((n, r) => n + r.items_approved, 0);
    const closed = reqs.filter((r) => r.closedAt && r.publishedAt);
    const cycles = rows.map((r) => r.cycle_days).filter((c): c is number => typeof c === "number");
    const onTime = closed.filter((r) => day(r.closedAt) <= r.dueDate).length;
    return {
      generatedAt: new Date().toISOString(), rows,
      summary: {
        total: rows.length, byStatus, overdue: rows.filter((r) => r.overdue).length,
        completionPct: itemsTotal ? Math.round((itemsApproved / itemsTotal) * 100) : 0, closedCount: closed.length,
        avgCycleDays: cycles.length ? Math.round((cycles.reduce((a, b) => a + b, 0) / cycles.length) * 10) / 10 : null,
        onTimePct: closed.length ? Math.round((onTime / closed.length) * 100) : null,
      },
    };
  });
}

export const STATUS_REPORT_COLUMNS = ["reference", "title", "tax_year", "status", "priority", "due_date", "days_left", "overdue", "items_total", "items_approved", "items_submitted", "published_at", "closed_at", "cycle_days"];
export const DATA_PACK_COLUMNS = ["request", "item", "file", "sheet", "currency", "source_row", "account_code", "account_name", "debit", "credit", "source_cells", "accepted_by", "accepted_at"];

/**
 * The data a person has ACCEPTED for one request, one line per account, with where each figure came from.
 * Only accepted trial-balance extractions are included: nothing a reviewer has not signed off on leaves the system.
 */
export async function approvedDataPack(ctx: ServiceContext, requestId: string): Promise<{ reference: string; rows: Record<string, unknown>[] }> {
  assertUuid(requestId, "Request");
  assertCan(ctx.session.role, "report.read");
  return scoped(ctx, async (tx) => {
    const [req] = await tx.select({ id: requests.id, reference: requests.reference }).from(requests).where(eq(requests.id, requestId));
    if (!req) throw new NotFoundError("Request");
    const accepted = await tx.select({
      id: proposals.id, itemId: proposals.itemId, fileId: proposals.fileId, decidedBy: proposals.decidedBy, decidedAt: proposals.decidedAt, payload: proposals.payload,
    }).from(proposals).where(and(eq(proposals.requestId, req.id), eq(proposals.kind, "extraction"), eq(proposals.status, "accepted"), ne(proposals.schemaKey, "supporting_document")));
    const out: Record<string, unknown>[] = [];
    if (accepted.length) {
      const itemRows = await tx.select({ id: requestItems.id, title: requestItems.title }).from(requestItems).where(inArray(requestItems.id, accepted.map((a) => a.itemId)));
      const fileRows = await tx.select({ id: files.id, name: files.originalName }).from(files).where(inArray(files.id, accepted.map((a) => a.fileId)));
      const userIds = [...new Set(accepted.map((a) => a.decidedBy).filter((x): x is string => !!x))];
      const userRows = userIds.length ? await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : [];
      for (const a of accepted) {
        const rows = await tx.select().from(extractedRows).where(eq(extractedRows.proposalId, a.id)).orderBy(asc(extractedRows.position));
        for (const r of rows) {
          const v = r.values as Record<string, string>;
          out.push({
            request: req.reference, item: itemRows.find((i) => i.id === a.itemId)?.title ?? "", file: fileRows.find((f) => f.id === a.fileId)?.name ?? "",
            sheet: r.sheet, currency: ((a.payload as { metadata?: Record<string, string> } | null)?.metadata?.currency) ?? "", source_row: r.sourceRow, account_code: v.account_code ?? "", account_name: v.account_name ?? "", debit: v.debit ?? "", credit: v.credit ?? "",
            source_cells: Object.values((r.cells ?? {}) as Record<string, string>).join(" "), accepted_by: userRows.find((u) => u.id === a.decidedBy)?.name ?? "",
            accepted_at: a.decidedAt ? a.decidedAt.toISOString() : "",
          });
        }
      }
    }
    await recordAudit(tx, {
      tenantId: ctx.session.tenantId, actor: auditActorOf(ctx), action: "report.exported", entityType: "request", entityId: req.id, requestRef: req.id,
      summary: `Exported the approved data pack for ${req.reference} (${out.length} line(s))`, after: { lines: out.length },
    });
    return { reference: req.reference, rows: out };
  });
}

/** CSV of the status report. The export (not the on-screen view) is recorded in the audit history. */
export async function exportStatusReportCsv(ctx: ServiceContext): Promise<string> {
  const report = await requestStatusReport(ctx);
  await scoped(ctx, (tx) => recordAudit(tx, {
    tenantId: ctx.session.tenantId, actor: auditActorOf(ctx), action: "report.exported", entityType: "report", entityId: null,
    summary: `Exported the request status report (${report.rows.length} request(s))`, after: { count: report.rows.length },
  }));
  return csvOf(STATUS_REPORT_COLUMNS, report.rows as unknown as Record<string, unknown>[]);
}
