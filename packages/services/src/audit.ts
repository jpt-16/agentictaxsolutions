import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { assertCan } from "@taxops/core";
import { auditEvents, verifyAuditChain } from "@taxops/db";
import { scoped, type ServiceContext } from "./context";

export interface AuditFilters {
  /** e.g. "item." matches item.submitted, item.approved … */
  actionPrefix?: string;
  entityType?: string;
  requestRef?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export async function listAudit(ctx: ServiceContext, f: AuditFilters = {}) {
  assertCan(ctx.session.role, "audit.read");
  return scoped(ctx, async (tx) => {
    const conds: (SQL | undefined)[] = [];
    if (f.actionPrefix) conds.push(sql`${auditEvents.action} like ${f.actionPrefix.replace(/[%_\\]/g, "\\$&") + "%"}`);
    if (f.entityType) conds.push(eq(auditEvents.entityType, f.entityType));
    if (f.requestRef) conds.push(eq(auditEvents.requestRef, f.requestRef));
    if (f.q?.trim()) {
      const like = `%${f.q.trim().replace(/[%_\\]/g, "\\$&")}%`;
      conds.push(or(ilike(auditEvents.summary, like), ilike(auditEvents.actorLabel, like)));
    }
    const where = and(...conds);
    const rows = await tx.select().from(auditEvents).where(where).orderBy(desc(auditEvents.seq))
      .limit(Math.min(f.limit ?? 50, 200)).offset(f.offset ?? 0);
    const total = (await tx.select({ n: sql<number>`count(*)::int` }).from(auditEvents).where(where))[0]!.n;
    return { rows, total };
  });
}

/** Recomputes the tenant's hash chain; used by the audit page and by operators. */
export async function verifyAuditTrail(ctx: ServiceContext) {
  assertCan(ctx.session.role, "audit.read");
  return scoped(ctx, (tx) => verifyAuditChain(tx, ctx.session.tenantId));
}
