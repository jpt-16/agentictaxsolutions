import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { can, daysUntil, isOverdue, todayIso, type Permission, type Role, ROLES } from "@taxops/core";
import { assignments, notifications, requests, tenants, users, withTenant, type Db, type Tx } from "@taxops/db";
import { scoped, type ServiceContext } from "./context";

export interface NotificationInput { type: string; title: string; body?: string; link?: string; dedupeKey?: string }

/**
 * Inserts notifications for the given users inside the caller's transaction. Idempotent per (user, dedupe key), so retries and
 * sweeps never double-notify. The database only lets rows be created for users of the same tenant.
 */
export async function notify(tx: Tx, tenantId: string, userIds: readonly string[], n: NotificationInput): Promise<number> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return 0;
  const title = n.title.slice(0, 200), body = (n.body ?? "").slice(0, 1000);
  // A plain INSERT (no RETURNING): Postgres applies the READ policy to returned rows, which would reject notifying someone else.
  // The driver's affected-row count tells us how many were really created (conflicts are skipped).
  const res = await tx.execute(sql`insert into notifications (tenant_id, user_id, type, title, body, link, dedupe_key) values
    ${sql.join(ids.map((u) => sql`(${tenantId}, ${u}, ${n.type}, ${title}, ${body}, ${n.link ?? null}, ${n.dedupeKey ?? null})`), sql`, `)}
    on conflict do nothing`);
  return Number((res as unknown as { rowCount?: number }).rowCount ?? 0);
}

/** Active users in the tenant whose role grants `permission`. */
export async function usersWithPermission(tx: Tx, permission: Permission): Promise<{ id: string; role: Role }[]> {
  const roles = ROLES.filter((r) => can(r, permission));
  const rows = await tx.select({ id: users.id, role: users.role }).from(users).where(and(eq(users.isActive, true), inArray(users.role, roles)));
  return rows as { id: string; role: Role }[];
}

/** Active contributors a request is assigned to: directly, or via their department or legal entity. */
export async function assigneesOfRequest(tx: Tx, requestId: string): Promise<string[]> {
  const a = await tx.select().from(assignments).where(eq(assignments.requestId, requestId));
  const direct = a.filter((x) => x.assigneeType === "user").map((x) => x.userId!);
  const depts = a.filter((x) => x.assigneeType === "department").map((x) => x.departmentId!);
  const ents = a.filter((x) => x.assigneeType === "entity").map((x) => x.entityId!);
  const viaGroups = depts.length || ents.length
    ? await tx.select({ id: users.id }).from(users).where(and(eq(users.isActive, true), eq(users.role, "contributor"),
        sql`(${depts.length ? sql`${users.departmentId} in (${sql.join(depts.map((d) => sql`${d}`), sql`, `)})` : sql`false`} or ${ents.length ? sql`${users.entityId} in (${sql.join(ents.map((d) => sql`${d}`), sql`, `)})` : sql`false`})`))
    : [];
  return [...new Set([...direct, ...viaGroups.map((u) => u.id)])];
}

export async function listNotifications(ctx: ServiceContext, opts: { unreadOnly?: boolean; limit?: number } = {}) {
  return scoped(ctx, async (tx) => {
    const where = opts.unreadOnly ? isNull(notifications.readAt) : undefined;
    return tx.select().from(notifications).where(where).orderBy(desc(notifications.createdAt)).limit(Math.min(opts.limit ?? 50, 200));
  });
}

export async function unreadCount(ctx: ServiceContext): Promise<number> {
  return scoped(ctx, async (tx) => (await tx.select({ n: sql<number>`count(*)::int` }).from(notifications).where(isNull(notifications.readAt)))[0]!.n);
}

/** Row-level security means these can only ever touch the caller's own notifications. */
export async function markRead(ctx: ServiceContext, id: string): Promise<void> {
  await scoped(ctx, (tx) => tx.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.id, id), isNull(notifications.readAt))));
}
export async function markAllRead(ctx: ServiceContext): Promise<void> {
  await scoped(ctx, (tx) => tx.update(notifications).set({ readAt: new Date() }).where(isNull(notifications.readAt)));
}

/**
 * Deadline reminders. Run on a schedule (`pnpm notify:sweep`) by an operator connection. Idempotent: "due soon" is sent once per
 * request, "overdue" once per request per day. Only people who still owe work get nudged (contributors assigned to the request).
 */
export async function sweepDeadlines(ownerDb: Db, opts: { today?: string; windowDays?: number } = {}) {
  const today = opts.today ?? todayIso();
  const windowDays = opts.windowDays ?? 3;
  const tenantIds = ((await ownerDb.execute(sql`select id from tenants`)).rows as { id: string }[]).map((r) => r.id);
  let sent = 0;
  for (const tenantId of tenantIds) {
    await withTenant(ownerDb, { tenantId }, async (tx) => {
      const open = await tx.select().from(requests).where(sql`${requests.status} in ('open', 'in_progress', 'changes_requested', 'in_review')`);
      for (const r of open) {
        const left = daysUntil(r.dueDate, today);
        const overdue = isOverdue(r.dueDate, r.status, today);
        if (!overdue && left > windowDays) continue;
        const who = await assigneesOfRequest(tx, r.id);
        sent += await notify(tx, tenantId, who, overdue
          ? { type: "overdue", title: `Overdue: ${r.title}`, body: `${r.reference} was due ${r.dueDate}.`, link: `/requests/${r.id}`, dedupeKey: `overdue:${r.id}:${today}` }
          : { type: "due_soon", title: `Due ${left === 0 ? "today" : `in ${left} day${left === 1 ? "" : "s"}`}: ${r.title}`, body: `${r.reference} is due ${r.dueDate}.`, link: `/requests/${r.id}`, dedupeKey: `soon:${r.id}` });
      }
    });
  }
  return { sent };
}
