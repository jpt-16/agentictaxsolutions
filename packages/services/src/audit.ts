import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { assertCan } from "@taxops/core";
import { auditEvents, verifyAuditChain } from "@taxops/db";
import { assertUuid, cleanQuery, clampInt, scoped, type ServiceContext } from "./context";

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
    const prefix = cleanQuery(f.actionPrefix, 60), entityType = cleanQuery(f.entityType, 60), q = cleanQuery(f.q);
    if (prefix) conds.push(sql`${auditEvents.action} like ${prefix.replace(/[%_\\]/g, "\\$&") + "%"}`);
    if (entityType) conds.push(eq(auditEvents.entityType, entityType));
    if (f.requestRef !== undefined && f.requestRef !== null && f.requestRef !== "") {
      try { assertUuid(f.requestRef, "Request"); conds.push(eq(auditEvents.requestRef, f.requestRef)); } catch { return { rows: [], total: 0 }; } // not an id: nothing can match
    }
    if (q) {
      const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
      conds.push(or(ilike(auditEvents.summary, like), ilike(auditEvents.actorLabel, like)));
    }
    const where = and(...conds);
    const rows = await tx.select().from(auditEvents).where(where).orderBy(desc(auditEvents.seq))
      .limit(clampInt(f.limit, 50, 1, 200)).offset(clampInt(f.offset, 0, 0, 1_000_000));
    const total = (await tx.select({ n: sql<number>`count(*)::int` }).from(auditEvents).where(where))[0]!.n;
    return { rows, total };
  });
}

/** Recomputes the tenant's hash chain; used by the audit page and by operators. */
export async function verifyAuditTrail(ctx: ServiceContext) {
  assertCan(ctx.session.role, "audit.read");
  return scoped(ctx, (tx) => verifyAuditChain(tx, ctx.session.tenantId));
}
