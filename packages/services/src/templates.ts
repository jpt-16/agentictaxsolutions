import { and, asc, eq, isNull } from "drizzle-orm";
import { assertCan, itemInputSchema } from "@taxops/core";
import { recordAudit, requestItems, requests, requestTemplates } from "@taxops/db";
import { z } from "zod";
import { auditActorOf, NotFoundError, scoped, type ServiceContext } from "./context";

const nameSchema = z.string().trim().min(3, "Give the template a name of at least 3 characters").max(120);
const storedItems = z.array(itemInputSchema).min(1).max(100);

/** A template keeps what a request ASKS for (title, items), never who it goes to, when it is due, or any submitted data. */
export async function createTemplateFromRequest(ctx: ServiceContext, requestId: string, rawName: unknown) {
  assertCan(ctx.session.role, "request.create");
  const name = nameSchema.parse(rawName);
  return scoped(ctx, async (tx) => {
    const [req] = await tx.select().from(requests).where(eq(requests.id, requestId));
    if (!req) throw new NotFoundError("Request");
    const items = await tx.select().from(requestItems).where(eq(requestItems.requestId, req.id)).orderBy(asc(requestItems.position));
    if (items.length === 0) throw new z.ZodError([{ code: "custom", path: ["name"], message: "A request with no items cannot become a template" }]);
    const payload = storedItems.parse(items.map((i) => ({ title: i.title, description: i.description, dataType: i.dataType, required: i.required })));
    const [t] = await tx.insert(requestTemplates).values({
      tenantId: ctx.session.tenantId, name, description: req.description, items: payload, createdBy: ctx.session.userId,
    }).returning({ id: requestTemplates.id });
    await recordAudit(tx, {
      tenantId: ctx.session.tenantId, actor: auditActorOf(ctx), action: "template.created", entityType: "request_template", entityId: t!.id,
      requestRef: req.id, summary: `Saved ${req.reference} as template "${name}"`, after: { name, items: payload.length },
    });
    return { id: t!.id };
  });
}

export async function listTemplates(ctx: ServiceContext) {
  assertCan(ctx.session.role, "request.create");
  return scoped(ctx, async (tx) => (await tx.select({ id: requestTemplates.id, name: requestTemplates.name, items: requestTemplates.items, createdAt: requestTemplates.createdAt })
    .from(requestTemplates).where(isNull(requestTemplates.archivedAt)).orderBy(asc(requestTemplates.name)))
    .map((t) => ({ id: t.id, name: t.name, itemCount: Array.isArray(t.items) ? t.items.length : 0, createdAt: t.createdAt })));
}

export async function getTemplate(ctx: ServiceContext, id: string) {
  assertCan(ctx.session.role, "request.create");
  return scoped(ctx, async (tx) => {
    const [t] = await tx.select().from(requestTemplates).where(and(eq(requestTemplates.id, id), isNull(requestTemplates.archivedAt)));
    if (!t) throw new NotFoundError("Template");
    const items = storedItems.safeParse(t.items); // the column is app-written, but never trust a stored blob blindly
    if (!items.success) throw new NotFoundError("Template");
    return { id: t.id, name: t.name, description: t.description, items: items.data };
  });
}

export async function archiveTemplate(ctx: ServiceContext, id: string) {
  assertCan(ctx.session.role, "request.create");
  return scoped(ctx, async (tx) => {
    const done = await tx.update(requestTemplates).set({ archivedAt: new Date() }).where(and(eq(requestTemplates.id, id), isNull(requestTemplates.archivedAt)))
      .returning({ id: requestTemplates.id, name: requestTemplates.name });
    if (done.length === 0) throw new NotFoundError("Template");
    await recordAudit(tx, {
      tenantId: ctx.session.tenantId, actor: auditActorOf(ctx), action: "template.archived", entityType: "request_template", entityId: id,
      summary: `Archived template "${done[0]!.name}"`, after: {},
    });
  });
}
