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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ids come from the browser. Anything that is not a UUID cannot exist, so it is "not found", never a database error. */
export function assertUuid(id: unknown, what = "Resource"): asserts id is string {
  if (typeof id !== "string" || !UUID.test(id)) throw new NotFoundError(what);
}
/** A free-text search value: control characters removed, length clamped. Undefined when nothing usable remains. */
export function cleanQuery(v: unknown, max = 200): string | undefined {
  if (typeof v !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, max);
  return t || undefined;
}
/** A whole number within [min, max]; the default for anything that is not a finite number (NaN, Infinity, strings, objects). */
export function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : fallback;
}
