import { asc, eq } from "drizzle-orm";
import { assertCan } from "@taxops/core";
import { departments, legalEntities, users } from "@taxops/db";
import { scoped, type ServiceContext } from "./context";

export async function listDirectory(ctx: ServiceContext) {
  assertCan(ctx.session.role, "user.read");
  return scoped(ctx, async (tx) => {
    const entities = await tx.select().from(legalEntities).orderBy(asc(legalEntities.name));
    const depts = await tx.select().from(departments).orderBy(asc(departments.name));
    const people = await tx.select({
      id: users.id, name: users.name, email: users.email, title: users.title, role: users.role,
      departmentId: users.departmentId, entityId: users.entityId,
    }).from(users).where(eq(users.isActive, true)).orderBy(asc(users.name));
    return { entities, departments: depts, users: people };
  });
}
