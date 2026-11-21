import { ROLE_LABELS, todayIso, type Actor, type Role } from "@taxops/core";
import { withTenant, type Db, type Tx, type AuditActor } from "@taxops/db";

/** The authenticated user, as loaded from the database for THIS request (never trusted from a token). */
export interface Session {
  userId: string;
  tenantId: string;
  role: Role;
  name: string;
  email: string;
  departmentId: string | null;
  entityId: string | null;
  /** Session tokens issued before this time (ms since epoch) are void; null = none revoked. */
  tokensValidAfterMs: number | null;
}

export interface ServiceContext {
  db: Db;
  session: Session;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export const actorOf = (c: ServiceContext): Actor => ({
  userId: c.session.userId,
  tenantId: c.session.tenantId,
  role: c.session.role,
  departmentId: c.session.departmentId,
  entityId: c.session.entityId,
});

export const auditActorOf = (c: ServiceContext): AuditActor => ({
  type: "user",
  id: c.session.userId,
  label: `${c.session.name} (${ROLE_LABELS[c.session.role]})`,
});

export const todayOf = (c: ServiceContext) => todayIso(c.now?.() ?? new Date());

/** Every service call runs inside a tenant-scoped transaction. */
export const scoped = <T>(c: ServiceContext, fn: (tx: Tx) => Promise<T>) =>
  withTenant(c.db, { tenantId: c.session.tenantId, userId: c.session.userId }, fn);

export class NotFoundError extends Error {
  constructor(what = "Resource") {
    super(`${what} not found.`);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}
