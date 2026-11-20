import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { can, daysUntil, isOverdue, type ItemStatus, type RequestStatus, REQUEST_STATUSES } from "@taxops/core";
import { auditEvents, requestItems, requests } from "@taxops/db";
import { actorOf, scoped, todayOf, type ServiceContext } from "./context";
import { visibleRequestsFilter } from "./requests";

const WORKABLE: RequestStatus[] = ["open", "in_progress", "changes_requested", "in_review"];

export async function getDashboard(ctx: ServiceContext) {
  const role = ctx.session.role;
  const today = todayOf(ctx);
  return scoped(ctx, async (tx) => {
    const reqs = await tx.select().from(requests).where(visibleRequestsFilter(actorOf(ctx)));
    const ids = reqs.map((r) => r.id);
    const items = ids.length
      ? await tx.select().from(requestItems).where(inArray(requestItems.requestId, ids))
      : [];
    const itemsByReq = new Map<string, typeof items>();
    for (const it of items) itemsByReq.set(it.requestId, [...(itemsByReq.get(it.requestId) ?? []), it]);

    const active = reqs.filter((r) => r.status !== "draft" && r.status !== "closed");
    const withProgress = (r: (typeof reqs)[number]) => {
      const its = itemsByReq.get(r.id) ?? [];
      return {
        id: r.id, reference: r.reference, title: r.title, dueDate: r.dueDate, priority: r.priority, status: r.status,
        overdue: isOverdue(r.dueDate, r.status, today), daysLeft: daysUntil(r.dueDate, today),
        itemCount: its.length, approvedCount: its.filter((i) => i.status === "approved").length,
      };
    };

    const activeItems = active.flatMap((r) => itemsByReq.get(r.id) ?? []);
    const byStatus = Object.fromEntries(REQUEST_STATUSES.map((s) => [s, 0])) as Record<RequestStatus, number>;
    for (const r of reqs) byStatus[r.status]++;

    const overdue = active.filter((r) => isOverdue(r.dueDate, r.status, today));
    const dueSoon = active.filter((r) => {
      const d = daysUntil(r.dueDate, today);
      return !isOverdue(r.dueDate, r.status, today) && r.status !== "approved" && d >= 0 && d <= 7;
    });

    // "Needs your attention": what this particular role should do next.
    let queue: { itemId: string; itemTitle: string; requestId: string; reference: string; dueDate: string; status: ItemStatus; overdue: boolean }[] = [];
    const wantStatuses: ItemStatus[] | null = can(role, "item.submit")
      ? ["pending", "changes_requested"] : can(role, "item.review") ? ["submitted"] : null;
    if (wantStatuses) {
      queue = active
        .filter((r) => WORKABLE.includes(r.status))
        .flatMap((r) => (itemsByReq.get(r.id) ?? [])
          .filter((i) => wantStatuses.includes(i.status))
          .map((i) => ({ itemId: i.id, itemTitle: i.title, requestId: r.id, reference: r.reference, dueDate: r.dueDate,
            status: i.status, overdue: isOverdue(r.dueDate, r.status, today) })))
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
        .slice(0, 8);
    }

    const recent = ids.length
      ? await tx.select({
          id: auditEvents.id, occurredAt: auditEvents.occurredAt, actorLabel: auditEvents.actorLabel,
          action: auditEvents.action, summary: auditEvents.summary, requestRef: auditEvents.requestRef,
        }).from(auditEvents).where(inArray(auditEvents.requestRef, ids)).orderBy(desc(auditEvents.seq)).limit(8)
      : [];

    const totalActiveItems = activeItems.length;
    return {
      kpis: {
        activeRequests: active.length,
        overdue: overdue.length,
        dueSoon: dueSoon.length,
        awaitingReview: activeItems.filter((i) => i.status === "submitted").length,
        completionPct: totalActiveItems ? Math.round((activeItems.filter((i) => i.status === "approved").length / totalActiveItems) * 100) : 0,
      },
      byStatus,
      upcoming: active.filter((r) => r.status !== "approved").sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 6).map(withProgress),
      queue,
      queueKind: wantStatuses ? (can(role, "item.submit") ? "submit" : "review") : null,
      recent,
    };
  });
}
