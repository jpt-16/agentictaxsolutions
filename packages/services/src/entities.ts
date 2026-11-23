import { and, eq, sql } from "drizzle-orm";
import { assertCan, resolveEntity, type EntityRef, type EntityResolution, type EntitySource } from "@taxops/core";
import { assignments, files, legalEntities, proposalEntities, proposals, recordAudit, submissions, users, type Tx } from "@taxops/db";
import { assertUuid, auditActorOf, ConflictError, NotFoundError, scoped, type ServiceContext } from "./context";

type ProposalRow = typeof proposals.$inferSelect;

/** What a reviewer sees about "whose books is this?": the stored choice, the evidence, and the entities they may pick from. */
export interface ProposalEntityState {
  chosen: { entity: EntityRef; source: EntitySource } | null;
  resolution: EntityResolution;
  options: EntityRef[];
}

const isTrialBalance = (p: ProposalRow) => p.kind === "extraction" && (p.schemaKey ?? "trial_balance") === "trial_balance";

export async function listEntityRefs(tx: Tx): Promise<EntityRef[]> {
  const rows = await tx.select({ id: legalEntities.id, code: legalEntities.code, name: legalEntities.name }).from(legalEntities).orderBy(legalEntities.code);
  return rows;
}

/** Works out the evidence for one trial balance. Reads only; the decision is written by confirmEntity / setProposalEntity. */
export async function entityStateFor(tx: Tx, p: ProposalRow, fileName: string): Promise<ProposalEntityState | null> {
  if (!isTrialBalance(p)) return null;
  const options = await listEntityRefs(tx);
  const [stored] = await tx.select({ entityId: proposalEntities.entityId, source: proposalEntities.source }).from(proposalEntities).where(eq(proposalEntities.proposalId, p.id));
  const [file] = await tx.select({ submissionId: files.submissionId }).from(files).where(eq(files.id, p.fileId));
  const [uploader] = file
    ? await tx.select({ entityId: users.entityId }).from(submissions)
        .innerJoin(users, and(eq(users.tenantId, submissions.tenantId), eq(users.id, submissions.submittedBy))).where(eq(submissions.id, file.submissionId))
    : [];
  const assigned = await tx.select({ entityId: assignments.entityId }).from(assignments).where(and(eq(assignments.requestId, p.requestId), eq(assignments.assigneeType, "entity")));
  const meta = ((p.payload as { metadata?: Record<string, string> } | null)?.metadata ?? {}) as Record<string, string>;
  const resolution = resolveEntity({
    entities: options,
    assignedEntityIds: assigned.map((a) => a.entityId).filter((x): x is string => !!x),
    uploaderEntityId: uploader?.entityId ?? null,
    texts: [meta.title_text ?? "", meta.entity_hint ?? "", fileName],
  });
  const chosenEntity = stored ? options.find((o) => o.id === stored.entityId) : undefined;
  return { chosen: stored && chosenEntity ? { entity: chosenEntity, source: stored.source as EntitySource } : null, resolution, options };
}

/** A reviewer picks the entity for a pending trial balance. Frozen once the result is decided (enforced by a database trigger too). */
export async function setProposalEntity(ctx: ServiceContext, proposalId: string, entityId: string) {
  assertCan(ctx.session.role, "proposal.review");
  assertUuid(proposalId, "Proposal");
  assertUuid(entityId, "Entity");
  return scoped(ctx, async (tx) => {
    const [p] = await tx.select().from(proposals).where(eq(proposals.id, proposalId));
    if (!p || !isTrialBalance(p)) throw new NotFoundError("Trial balance result");
    if (p.status !== "pending") throw new ConflictError(`This result was already ${p.status}, so its entity can no longer be changed.`);
    const [entity] = await tx.select({ id: legalEntities.id, code: legalEntities.code, name: legalEntities.name }).from(legalEntities).where(eq(legalEntities.id, entityId));
    if (!entity) throw new NotFoundError("Entity");
    const [before] = await tx.select({ entityId: proposalEntities.entityId }).from(proposalEntities).where(eq(proposalEntities.proposalId, proposalId));
    await tx.insert(proposalEntities).values({ proposalId, tenantId: ctx.session.tenantId, entityId, source: "reviewer", setBy: ctx.session.userId })
      .onConflictDoUpdate({ target: proposalEntities.proposalId, set: { entityId, source: "reviewer", setBy: ctx.session.userId, setAt: new Date() } });
    await recordAudit(tx, {
      tenantId: ctx.session.tenantId, actor: auditActorOf(ctx), action: "proposal.entity_set", entityType: "proposal", entityId: p.id, requestRef: p.requestId,
      summary: `Set the entity of "${p.title}" to ${entity.name} (${entity.code})`,
      before: { entityId: before?.entityId ?? null }, after: { entityId, source: "reviewer" },
    });
  });
}

/**
 * Called when a reviewer ACCEPTS a trial balance. Accepting confirms the entity: either the one already chosen, or the single clear
 * suggestion. If the evidence is missing or conflicting, accepting is refused until the reviewer chooses, so reconciliation never
 * works from a guess. Tenants that have defined no entities are not blocked.
 */
export async function confirmEntityOnAccept(tx: Tx, ctx: ServiceContext, p: ProposalRow, fileName: string): Promise<void> {
  // Two reviewers can accept at the same moment. Take the row lock first and look again: if the other one already decided, do nothing here
  // and let the decision's own conditional update report "already decided" cleanly.
  await tx.execute(sql`select 1 from proposals where id = ${p.id} for update`);
  const [fresh] = await tx.select({ status: proposals.status }).from(proposals).where(eq(proposals.id, p.id));
  if (!fresh || fresh.status !== "pending") return;
  const state = await entityStateFor(tx, p, fileName);
  if (!state || state.options.length === 0 || state.chosen) return;
  const { resolution } = state;
  if (resolution.status !== "suggested" || !resolution.suggestion) {
    throw new ConflictError(
      resolution.status === "conflict"
        ? "Choose which entity this trial balance belongs to before accepting it: the file and the request disagree."
        : "Choose which entity this trial balance belongs to before accepting it.");
  }
  const { entity, source } = resolution.suggestion;
  await tx.insert(proposalEntities).values({ proposalId: p.id, tenantId: ctx.session.tenantId, entityId: entity.id, source, setBy: ctx.session.userId });
  await recordAudit(tx, {
    tenantId: ctx.session.tenantId, actor: auditActorOf(ctx), action: "proposal.entity_confirmed", entityType: "proposal", entityId: p.id, requestRef: p.requestId,
    summary: `Confirmed the entity of "${p.title}" as ${entity.name} (${entity.code}), from ${source === "file" ? "the file" : source === "assignment" ? "the request's assignment" : "the uploader"}`,
    before: null, after: { entityId: entity.id, source },
  });
}
