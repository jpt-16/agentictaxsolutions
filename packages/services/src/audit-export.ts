import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { assertCan } from "@taxops/core";
import { auditEvents, recordAudit, verifyAuditChain } from "@taxops/db";
import { auditActorOf, scoped, type ServiceContext } from "./context";

export interface ExportFilters { actionPrefix?: string; requestRef?: string }
export const EXPORT_LIMIT = 50_000;

export interface AuditExport {
  meta: { tenantId: string; exportedAt: string; exportedBy: string; filters: ExportFilters; count: number; firstSeq: number | null; lastSeq: number | null; complete: boolean; chain: { ok: boolean; brokenSeq: number | null; checked: number } };
  events: Record<string, unknown>[];
}

/**
 * Exports the audit trail with, per event, the exact text that was hashed. An external verifier can then re-check every
 * hash and link with SHA-256 alone (scripts/verify-audit-export.mjs). The export itself is audited AFTER it is produced, so it
 * is not part of the file it describes.
 */
export async function exportAudit(ctx: ServiceContext, filters: ExportFilters = {}): Promise<AuditExport> {
  assertCan(ctx.session.role, "audit.read");
  return scoped(ctx, async (tx) => {
    const conds: (SQL | undefined)[] = [];
    if (filters.actionPrefix) conds.push(sql`${auditEvents.action} like ${filters.actionPrefix.replace(/[%_\\]/g, "\\$&") + "%"}`);
    if (filters.requestRef) conds.push(eq(auditEvents.requestRef, filters.requestRef));
    const where = and(...conds);
    const rows = (await tx.execute(sql`
      select audit_events.seq, audit_events.occurred_at, audit_events.actor_type, audit_events.actor_id, audit_events.actor_label, audit_events.action,
             audit_events.entity_type, audit_events.entity_id, audit_events.request_ref, audit_events.summary, audit_events.before, audit_events.after,
             audit_events.prev_hash, audit_events.hash, audit_canonical(audit_events) as canonical
        from audit_events ${where ? sql`where ${where}` : sql``} order by audit_events.seq asc limit ${EXPORT_LIMIT + 1}`)).rows as Record<string, unknown>[];
    const complete = rows.length <= EXPORT_LIMIT;
    const events = rows.slice(0, EXPORT_LIMIT).map((r) => ({ ...r, seq: Number(r.seq), occurred_at: new Date(r.occurred_at as string | Date).toISOString() }));
    const chain = await verifyAuditChain(tx, ctx.session.tenantId);
    const meta = {
      tenantId: ctx.session.tenantId, exportedAt: new Date().toISOString(), exportedBy: ctx.session.name, filters, count: events.length,
      firstSeq: events.length ? (events[0]!.seq as number) : null, lastSeq: events.length ? (events.at(-1)!.seq as number) : null, complete, chain,
    };
    await recordAudit(tx, {
      tenantId: ctx.session.tenantId, actor: auditActorOf(ctx), action: "audit.exported", entityType: "audit_log", entityId: null,
      summary: `Exported ${events.length} audit event(s)`, after: { count: events.length, filters, chainOk: chain.ok },
    });
    return { meta, events };
  });
}

const FORMULA = /^[=+\-@\t\r]/;
/** CSV with spreadsheet-formula neutralisation on human-entered text, so an opened export can never execute anything. */
export function toCsv(exp: AuditExport): string {
  const cols = ["seq", "occurred_at", "actor_type", "actor_label", "action", "entity_type", "entity_id", "request_ref", "summary", "before", "after", "prev_hash", "hash", "canonical"] as const;
  const free = new Set(["actor_label", "summary", "before", "after", "canonical"]);
  const cell = (k: string, v: unknown) => {
    let t = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    if (free.has(k) && FORMULA.test(t)) t = "'" + t;
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return [cols.join(","), ...exp.events.map((e) => cols.map((c) => cell(c, e[c])).join(","))].join("\r\n") + "\r\n";
}
