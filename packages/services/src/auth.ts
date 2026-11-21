import { eq, sql } from "drizzle-orm";
import { recordAudit, users, withoutTenant, withTenant, type Db } from "@taxops/db";
import type { Role } from "@taxops/core";
import type { Session } from "./context";

export interface DevLoginUser { userId: string; name: string; email: string; title: string; role: Role }

/** Dev-only sign-in picker. The DB function itself refuses unless dev login is switched on. */
export async function listDevLoginUsers(db: Db, tenantSlug: string): Promise<DevLoginUser[]> {
  return withoutTenant(db, { allowDevLogin: true }, async (tx) => {
    const res = await tx.execute(sql`select user_id, name, email, title, role from auth_dev_list_users(${tenantSlug})`);
    return (res.rows as any[]).map((r) => ({ userId: r.user_id, name: r.name, email: r.email, title: r.title, role: r.role }));
  });
}

/** Resolves which tenant an email belongs to (used before a tenant context exists). */
export async function resolveUserByEmail(db: Db, email: string) {
  return withoutTenant(db, {}, async (tx) => {
    const res = await tx.execute(sql`select user_id, tenant_id, role, is_active from auth_resolve_user(${email})`);
    const r = res.rows[0] as any;
    return r ? { userId: r.user_id as string, tenantId: r.tenant_id as string, role: r.role as Role, isActive: r.is_active as boolean } : null;
  });
}

/**
 * Builds the request Session from the database. Role, scope and active-state are re-read on every
 * request, so revoking a user or changing their role takes effect immediately (no stale tokens).
 */
export async function loadSession(db: Db, tenantId: string, userId: string): Promise<Session | null> {
  return withTenant(db, { tenantId }, async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, userId));
    if (!u || !u.isActive) return null;
    return { userId: u.id, tenantId: u.tenantId, role: u.role, name: u.name, email: u.email, departmentId: u.departmentId, entityId: u.entityId, tokensValidAfterMs: u.tokensValidAfter ? u.tokensValidAfter.getTime() : null };
  });
}

/** Records a successful sign-in in the tenant's audit trail (who, when, and by which method). */
export async function recordLogin(db: Db, tenantId: string, userId: string, method: "sso" | "dev"): Promise<void> {
  await withTenant(db, { tenantId, userId }, async (tx) => {
    const [u] = await tx.select({ name: users.name, role: users.role }).from(users).where(eq(users.id, userId));
    if (!u) return;
    await recordAudit(tx, { tenantId, actor: { type: "user", id: userId, label: u.name }, action: "auth.login", entityType: "user", entityId: userId, summary: `${u.name} signed in (${method === "sso" ? "single sign-on" : "development sign-in"})`, after: { method } });
  });
}

/**
 * Server-side sign-out: every session token this person holds, on every device, stops working immediately. (Deleting the cookie
 * alone would leave a copied token valid until it expires.) Runs through a database function that can only touch the caller's own row.
 */
export async function revokeMySessions(db: Db, tenantId: string, userId: string, name: string): Promise<void> {
  await withTenant(db, { tenantId, userId }, async (tx) => {
    await tx.execute(sql`select revoke_my_sessions()`);
    await recordAudit(tx, { tenantId, actor: { type: "user", id: userId, label: name }, action: "auth.logout", entityType: "user", entityId: userId, summary: `${name} signed out`, after: {} });
  });
}

/** The database's clock in ms. Session issue times and revocation times both come from it, so clock skew between servers cannot leave a token valid after sign-out. */
export async function databaseNowMs(db: Db): Promise<number> {
  const res = await db.execute(sql`select (extract(epoch from clock_timestamp()) * 1000)::bigint as ms`);
  return Number((res.rows[0] as { ms: string | number }).ms);
}
