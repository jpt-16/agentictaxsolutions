import { and, asc, eq, gt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { assertCan, ForbiddenError, NO_CONTROL_CHARS, NO_CONTROL_MESSAGE, ROLES, ROLE_LABELS } from "@taxops/core";
import { agentRuns, departments, legalEntities, recordAudit, tenants, users } from "@taxops/db";
import { auditActorOf, ConflictError, NotFoundError, scoped, type ServiceContext, assertUuid } from "./context";

/**
 * Database triggers are the authority on who may administer users and tenant settings. When one fires, its message is written for
 * people, so surface it (instead of a generic failure). Anything else is re-thrown untouched.
 */
export function friendlyDbError(e: unknown): never {
  let cur: any = e;
  while (cur) {
    if (cur.routine === "exec_stmt_raise" && typeof cur.message === "string") {
      if (cur.code === "42501") throw new ForbiddenError(capitalize(cur.message));
      if (cur.code === "23514") throw new ConflictError(capitalize(cur.message));
    }
    if (cur.code === "23505" && /users_email/.test(String(cur.constraint ?? cur.message))) throw new ConflictError("A user with that email already exists.");
    cur = cur.cause;
  }
  throw e;
}
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1) + (s.endsWith(".") ? "" : ".");

export async function getTenantSettings(ctx: ServiceContext) {
  assertCan(ctx.session.role, "tenant.admin");
  return scoped(ctx, async (tx) => {
    const [t] = await tx.select({ name: tenants.name, aiExtractionEnabled: tenants.aiExtractionEnabled, externalLlmEnabled: tenants.externalLlmEnabled, llmDailyCallLimit: tenants.llmDailyCallLimit }).from(tenants);
    const [u] = await tx.select({ n: sql<number>`coalesce(sum(${agentRuns.llmCalls}), 0)::int` }).from(agentRuns).where(gt(agentRuns.createdAt, sql`now() - interval '24 hours'`));
    return { ...t!, llmCallsLast24h: u?.n ?? 0 };
  });
}

const settingsSchema = z.object({
  aiExtractionEnabled: z.boolean().optional(),
  externalLlmEnabled: z.boolean().optional(),
  /** Spending limit: external model calls per rolling 24 hours. 0 stops all external calls. */
  llmDailyCallLimit: z.number({ message: "Enter a whole number" }).int("Enter a whole number").min(0, "The limit cannot be negative").max(100_000, "The limit is too high").optional(),
}).refine((v) => v.aiExtractionEnabled !== undefined || v.externalLlmEnabled !== undefined || v.llmDailyCallLimit !== undefined, "Nothing to change");

export async function updateTenantSettings(ctx: ServiceContext, raw: unknown) {
  assertCan(ctx.session.role, "tenant.admin");
  const input = settingsSchema.parse(raw);
  try {
    return await scoped(ctx, async (tx) => {
      const [before] = await tx.select({ a: tenants.aiExtractionEnabled, e: tenants.externalLlmEnabled, l: tenants.llmDailyCallLimit }).from(tenants);
      // External model use only makes sense with AI extraction on; turning AI off also turns external use off (fail safe).
      const aiNext = input.aiExtractionEnabled ?? before!.a;
      const extNext = aiNext ? (input.externalLlmEnabled ?? before!.e) : false;
      const limitNext = input.llmDailyCallLimit ?? before!.l;
      await tx.update(tenants).set({ aiExtractionEnabled: aiNext, externalLlmEnabled: extNext, llmDailyCallLimit: limitNext });
      await recordAudit(tx, {
        tenantId: ctx.session.tenantId, actor: auditActorOf(ctx), action: "tenant.settings_updated", entityType: "tenant", entityId: ctx.session.tenantId,
        summary: `Set AI extraction ${aiNext ? "on" : "off"}, external AI model use ${extNext ? "on" : "off"}, daily external AI call limit ${limitNext}`,
        before: { aiExtractionEnabled: before!.a, externalLlmEnabled: before!.e, llmDailyCallLimit: before!.l }, after: { aiExtractionEnabled: aiNext, externalLlmEnabled: extNext, llmDailyCallLimit: limitNext },
      });
    });
  } catch (e) { friendlyDbError(e); }
}

export async function listUsers(ctx: ServiceContext) {
  assertCan(ctx.session.role, "tenant.admin");
  return scoped(ctx, async (tx) => {
    const rows = await tx.select({
      id: users.id, name: users.name, email: users.email, title: users.title, role: users.role, isActive: users.isActive,
      departmentId: users.departmentId, entityId: users.entityId, department: departments.name, entity: legalEntities.name,
    }).from(users)
      .leftJoin(departments, and(eq(departments.tenantId, users.tenantId), eq(departments.id, users.departmentId)))
      .leftJoin(legalEntities, and(eq(legalEntities.tenantId, users.tenantId), eq(legalEntities.id, users.entityId)))
      .orderBy(asc(users.name));
    const depts = await tx.select({ id: departments.id, name: departments.name }).from(departments).orderBy(asc(departments.name));
    const ents = await tx.select({ id: legalEntities.id, name: legalEntities.name }).from(legalEntities).orderBy(asc(legalEntities.name));
    return { users: rows, departments: depts, entities: ents };
  });
}

const userFields = {
  name: z.string().regex(NO_CONTROL_CHARS, NO_CONTROL_MESSAGE).trim().min(2).max(120),
  title: z.string().regex(NO_CONTROL_CHARS, NO_CONTROL_MESSAGE).trim().max(120).default(""),
  role: z.enum(ROLES),
  departmentId: z.string().uuid().nullable().default(null),
  entityId: z.string().uuid().nullable().default(null),
};
const createUserSchema = z.object({ email: z.string().trim().toLowerCase().email().max(200), ...userFields });
const updateUserSchema = z.object({ ...userFields, isActive: z.boolean() }).partial();

export async function createUser(ctx: ServiceContext, raw: unknown) {
  assertCan(ctx.session.role, "tenant.admin");
  const input = createUserSchema.parse(raw);
  try {
    return await scoped(ctx, async (tx) => {
      const [u] = await tx.insert(users).values({ tenantId: ctx.session.tenantId, ...input }).returning({ id: users.id });
      await recordAudit(tx, {
        tenantId: ctx.session.tenantId, actor: auditActorOf(ctx), action: "user.created", entityType: "user", entityId: u!.id,
        summary: `Added ${input.name} as ${ROLE_LABELS[input.role]}`, after: { email: input.email, role: input.role, departmentId: input.departmentId, entityId: input.entityId },
      });
      return { id: u!.id };
    });
  } catch (e) { friendlyDbError(e); }
}

export async function updateUser(ctx: ServiceContext, userId: string, raw: unknown) {
  assertUuid(userId, "User");
  assertCan(ctx.session.role, "tenant.admin");
  const patch = updateUserSchema.parse(raw);
  try {
    return await scoped(ctx, async (tx) => {
      const [before] = await tx.select().from(users).where(and(eq(users.id, userId), ne(users.id, "00000000-0000-0000-0000-000000000000")));
      if (!before) throw new NotFoundError("User");
      await tx.update(users).set(patch).where(eq(users.id, userId));
      const changed = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== (before as Record<string, unknown>)[k]);
      await recordAudit(tx, {
        tenantId: ctx.session.tenantId, actor: auditActorOf(ctx), action: patch.isActive === false && before.isActive ? "user.deactivated" : "user.updated",
        entityType: "user", entityId: userId,
        summary: `${patch.isActive === false && before.isActive ? "Deactivated" : "Updated"} ${before.name}${changed.length ? ` (${changed.join(", ")})` : ""}`,
        before: Object.fromEntries(changed.map((k) => [k, (before as Record<string, unknown>)[k]])), after: Object.fromEntries(changed.map((k) => [k, (patch as Record<string, unknown>)[k]])),
      });
    });
  } catch (e) { friendlyDbError(e); }
}
