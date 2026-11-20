import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  assertCan, assertCanClose, REQUEST_STATUS_LABELS, assertCanPublish, assertItemTransition, can, canViewRequest, createRequestSchema,
  commentSchema, daysUntil, deriveRequestStatus, isOverdue, reviewItemSchema, submitItemSchema,
  violatesSegregationOfDuties, ForbiddenError, InvalidTransitionError,
  type Actor, type AssigneeRef, type ItemStatus, type RequestStatus,
} from "@taxops/core";
import {
  assignments, auditEvents, comments, departments, files as filesTable, jobs, legalEntities, recordAudit, requestItems, requests, reviews,
  submissions, users, type Tx,
} from "@taxops/db";
import type { StoredFile } from "./files/types";
import { extractionByFile, findingsForRequest } from "./proposals";
import { assigneesOfRequest, notify, usersWithPermission } from "./notifications";
import { isPreviewable } from "./files/validate";
import { actorOf, auditActorOf, NotFoundError, scoped, todayOf, type ServiceContext } from "./context";

/* ------------------------------------------------------------------ visibility */

/** SQL predicate limiting `requests` rows to what the actor may see (ABAC on top of tenant RLS). */
export function visibleRequestsFilter(actor: Actor): SQL | undefined {
  if (can(actor.role, "request.read.all")) return undefined;
  if (!can(actor.role, "request.read.assigned")) return sql`false`;
  const targets: SQL[] = [sql`(a.assignee_type = 'user' and a.user_id = ${actor.userId})`];
  if (actor.departmentId) targets.push(sql`(a.assignee_type = 'department' and a.department_id = ${actor.departmentId})`);
  if (actor.entityId) targets.push(sql`(a.assignee_type = 'entity' and a.entity_id = ${actor.entityId})`);
  return sql`(${requests.status} <> 'draft' and exists (
    select 1 from assignments a where a.request_id = ${requests.id} and (${sql.join(targets, sql` or `)})))`;
}

async function assigneeRefs(tx: Tx, requestId: string): Promise<AssigneeRef[]> {
  const rows = await tx.select().from(assignments).where(eq(assignments.requestId, requestId));
  return rows.map((a) => ({
    type: a.assigneeType,
    id: (a.assigneeType === "user" ? a.userId : a.assigneeType === "department" ? a.departmentId : a.entityId)!,
  }));
}

/** Loads a request the actor may see, or throws NotFound (never reveals that a hidden request exists). */
export async function loadVisibleRequest(tx: Tx, ctx: ServiceContext, requestId: string, lock = false) {
  const q = tx.select().from(requests).where(eq(requests.id, requestId));
  const [req] = lock ? await q.for("update") : await q;
  if (!req) throw new NotFoundError("Request");
  const actor = actorOf(ctx);
  const refs = await assigneeRefs(tx, requestId);
  const visible = canViewRequest(actor, refs) && (can(actor.role, "request.read.all") || req.status !== "draft");
  if (!visible) throw new NotFoundError("Request");
  return { req, refs };
}

/* ------------------------------------------------------------------ list */

export interface RequestListFilters {
  status?: RequestStatus | "overdue" | "active";
  q?: string;
  sort?: "due" | "created" | "title";
  limit?: number;
  offset?: number;
}

export async function listRequests(ctx: ServiceContext, f: RequestListFilters = {}) {
  assertCanRead(ctx);
  const today = todayOf(ctx);
  return scoped(ctx, async (tx) => {
    const conds: (SQL | undefined)[] = [visibleRequestsFilter(actorOf(ctx))];
    if (f.status === "overdue") conds.push(sql`${requests.dueDate} < ${today} and ${requests.status} not in ('draft','approved','closed')`);
    else if (f.status === "active") conds.push(sql`${requests.status} not in ('draft','closed')`);
    else if (f.status) conds.push(eq(requests.status, f.status));
    if (f.q?.trim()) {
      const like = `%${f.q.trim().replace(/[%_\\]/g, "\\$&")}%`;
      conds.push(or(ilike(requests.title, like), ilike(requests.reference, like)));
    }
    const where = and(...conds);
    // Default ordering keeps finished work (approved/closed) below anything still needing attention.
    const finishedLast = sql`case when ${requests.status} in ('approved', 'closed') then 1 else 0 end`;
    const order = f.sort === "title" ? [asc(requests.title)] : f.sort === "created" ? [desc(requests.createdAt)] : [finishedLast, asc(requests.dueDate)];
    const rows = await tx.select().from(requests).where(where).orderBy(...order, asc(requests.reference))
      .limit(Math.min(f.limit ?? 50, 200)).offset(f.offset ?? 0);
    const total = (await tx.select({ n: sql<number>`count(*)::int` }).from(requests).where(where))[0]!.n;
    if (rows.length === 0) return { rows: [], total };

    const ids = rows.map((r) => r.id);
    const itemRows = await tx.select({ requestId: requestItems.requestId, status: requestItems.status })
      .from(requestItems).where(inArray(requestItems.requestId, ids));
    const assignRows = await assigneeLabels(tx, ids);
    return {
      total,
      rows: rows.map((r) => {
        const items = itemRows.filter((i) => i.requestId === r.id);
        return {
          id: r.id, reference: r.reference, title: r.title, taxYear: r.taxYear, dueDate: r.dueDate,
          priority: r.priority, status: r.status,
          overdue: isOverdue(r.dueDate, r.status, today),
          daysLeft: daysUntil(r.dueDate, today),
          itemCount: items.length,
          approvedCount: items.filter((i) => i.status === "approved").length,
          assignees: assignRows.get(r.id) ?? [],
        };
      }),
    };
  });
}

function assertCanRead(ctx: ServiceContext) {
  const r = ctx.session.role;
  if (!can(r, "request.read.all") && !can(r, "request.read.assigned")) throw new ForbiddenError();
}

export interface AssigneeLabel { type: "department" | "entity" | "user"; id: string; label: string }

async function assigneeLabels(tx: Tx, requestIds: string[]): Promise<Map<string, AssigneeLabel[]>> {
  const rows = await tx
    .select({
      requestId: assignments.requestId, type: assignments.assigneeType, userId: assignments.userId,
      departmentId: assignments.departmentId, entityId: assignments.entityId,
      userName: users.name, deptName: departments.name, entityName: legalEntities.name,
    })
    .from(assignments)
    .leftJoin(users, and(eq(users.tenantId, assignments.tenantId), eq(users.id, assignments.userId)))
    .leftJoin(departments, and(eq(departments.tenantId, assignments.tenantId), eq(departments.id, assignments.departmentId)))
    .leftJoin(legalEntities, and(eq(legalEntities.tenantId, assignments.tenantId), eq(legalEntities.id, assignments.entityId)))
    .where(inArray(assignments.requestId, requestIds));
  const map = new Map<string, AssigneeLabel[]>();
  for (const r of rows) {
    const label: AssigneeLabel =
      r.type === "user" ? { type: "user", id: r.userId!, label: r.userName ?? "Unknown user" }
      : r.type === "department" ? { type: "department", id: r.departmentId!, label: r.deptName ?? "Unknown department" }
      : { type: "entity", id: r.entityId!, label: r.entityName ?? "Unknown entity" };
    map.set(r.requestId, [...(map.get(r.requestId) ?? []), label]);
  }
  return map;
}

const kindFromName = (n: string) => (n.split(".").pop() ?? "").toLowerCase();

/* ------------------------------------------------------------------ detail */

export async function getRequestDetail(ctx: ServiceContext, requestId: string) {
  assertCanRead(ctx);
  const today = todayOf(ctx);
  const actor = actorOf(ctx);
  return scoped(ctx, async (tx) => {
    const { req } = await loadVisibleRequest(tx, ctx, requestId);
    // Sequential on purpose: one transaction = one connection; queries cannot run concurrently on it.
    const items = await tx.select().from(requestItems).where(eq(requestItems.requestId, requestId)).orderBy(asc(requestItems.position));
    const assigneeMap = await assigneeLabels(tx, [requestId]);
    const subs = await tx.select({
        id: submissions.id, itemId: submissions.itemId, version: submissions.version, note: submissions.note,
        submittedBy: submissions.submittedBy, submitterName: users.name, createdAt: submissions.createdAt,
      }).from(submissions)
        .innerJoin(requestItems, and(eq(requestItems.tenantId, submissions.tenantId), eq(requestItems.id, submissions.itemId)))
        .innerJoin(users, and(eq(users.tenantId, submissions.tenantId), eq(users.id, submissions.submittedBy)))
        .where(eq(requestItems.requestId, requestId)).orderBy(desc(submissions.version));
    const fileRows = await tx.select({
        id: filesTable.id, submissionId: filesTable.submissionId, name: filesTable.originalName, contentType: filesTable.contentType,
        size: filesTable.sizeBytes, sha256: filesTable.sha256,
      }).from(filesTable)
        .innerJoin(submissions, and(eq(submissions.tenantId, filesTable.tenantId), eq(submissions.id, filesTable.submissionId)))
        .innerJoin(requestItems, and(eq(requestItems.tenantId, submissions.tenantId), eq(requestItems.id, submissions.itemId)))
        .where(eq(requestItems.requestId, requestId)).orderBy(asc(filesTable.originalName));
    const extraction = await extractionByFile(tx, ctx, fileRows.map((f) => f.id));
    const validation = await findingsForRequest(tx, ctx, requestId);
    const reviewRows = await tx.select({
        submissionId: reviews.submissionId, decision: reviews.decision, rationale: reviews.rationale,
        reviewerName: users.name, createdAt: reviews.createdAt,
      }).from(reviews)
        .innerJoin(users, and(eq(users.tenantId, reviews.tenantId), eq(users.id, reviews.reviewerId)));
    const commentRows = await tx.select({
        id: comments.id, itemId: comments.itemId, body: comments.body, createdAt: comments.createdAt,
        authorId: comments.authorId, authorName: users.name, authorRole: users.role,
      }).from(comments)
        .innerJoin(users, and(eq(users.tenantId, comments.tenantId), eq(users.id, comments.authorId)))
        .where(eq(comments.requestId, requestId)).orderBy(asc(comments.createdAt));
    // Activity feed shows who-did-what; field-level diffs stay in the audit log (audit.read only).
    const activity = await tx.select({
        id: auditEvents.id, occurredAt: auditEvents.occurredAt, actorLabel: auditEvents.actorLabel,
        action: auditEvents.action, summary: auditEvents.summary,
      }).from(auditEvents).where(and(eq(auditEvents.requestRef, requestId), sql`${auditEvents.action} not in ('file.viewed', 'file.downloaded')`)).orderBy(desc(auditEvents.seq)).limit(100);
    const creator = await tx.select({ name: users.name }).from(users).where(eq(users.id, req.createdBy));

    const reviewBySub = new Map(reviewRows.map((r) => [r.submissionId, r]));
    const subsByItem = new Map<string, typeof subs>();
    for (const s of subs) subsByItem.set(s.itemId, [...(subsByItem.get(s.itemId) ?? []), s]);

    const editable = req.status !== "draft" && req.status !== "closed" && req.status !== "approved";
    const itemDtos = items.map((it) => {
      const history = (subsByItem.get(it.id) ?? []).map((s) => ({
        ...s, review: reviewBySub.get(s.id) ?? null,
        files: fileRows.filter((f) => f.submissionId === s.id).map((f) => ({
          id: f.id, name: f.name, size: f.size, sha256: f.sha256, previewable: isPreviewable(kindFromName(f.name)), extraction: extraction?.get(f.id) ?? null,
        })),
      }));
      const latest = history[0] ?? null;
      return {
        id: it.id, position: it.position, title: it.title, description: it.description, dataType: it.dataType,
        required: it.required, status: it.status as ItemStatus,
        submissions: history,
        can: {
          submit: editable && can(actor.role, "item.submit") && (it.status === "pending" || it.status === "changes_requested"),
          review: editable && can(actor.role, "item.review") && it.status === "submitted"
            && !(latest && violatesSegregationOfDuties(actor.userId, latest.submittedBy)),
        },
        reviewBlockedBySod: editable && can(actor.role, "item.review") && it.status === "submitted"
          && !!latest && violatesSegregationOfDuties(actor.userId, latest.submittedBy),
      };
    });

    return {
      id: req.id, reference: req.reference, title: req.title, description: req.description, taxYear: req.taxYear,
      dueDate: req.dueDate, priority: req.priority, status: req.status,
      overdue: isOverdue(req.dueDate, req.status, today), daysLeft: daysUntil(req.dueDate, today),
      createdAt: req.createdAt, publishedAt: req.publishedAt, closedAt: req.closedAt,
      createdByName: creator[0]?.name ?? "Unknown",
      assignees: assigneeMap.get(requestId) ?? [],
      validation,
      items: itemDtos,
      comments: commentRows,
      activity,
      can: {
        publish: can(actor.role, "request.publish") && req.status === "draft",
        close: can(actor.role, "request.close") && req.status === "approved",
        comment: can(actor.role, "comment.create") && req.status !== "closed",
        reprocess: can(actor.role, "proposal.review"),
        edit: can(actor.role, "request.update") && req.status === "draft",
      },
    };
  });
}

/* ------------------------------------------------------------------ create / publish / close */

export async function createRequest(ctx: ServiceContext, rawInput: unknown) {
  assertCan(ctx.session.role, "request.create");
  const input = createRequestSchema.parse(rawInput);
  return scoped(ctx, async (tx) => {
    const tenantId = ctx.session.tenantId;
    // Reference numbers are sequential per tenant and year; serialize allocation.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"ref:" + tenantId}, 0))`);
    const seq = (await tx.select({ n: sql<number>`count(*)::int` }).from(requests).where(eq(requests.taxYear, input.taxYear)))[0]!.n + 1;
    const reference = `TX-${input.taxYear}-${String(seq).padStart(4, "0")}`;

    const [req] = await tx.insert(requests).values({
      tenantId, reference, title: input.title, description: input.description, taxYear: input.taxYear,
      dueDate: input.dueDate, priority: input.priority, status: "draft", createdBy: ctx.session.userId,
    }).returning();

    if (input.items.length) {
      await tx.insert(requestItems).values(input.items.map((it, i) => ({
        tenantId, requestId: req!.id, position: i + 1, title: it.title, description: it.description,
        dataType: it.dataType, required: it.required,
      })));
    }
    if (input.assignees.length) {
      await tx.insert(assignments).values(input.assignees.map((a) => ({
        tenantId, requestId: req!.id, assigneeType: a.type,
        departmentId: a.type === "department" ? a.id : null,
        entityId: a.type === "entity" ? a.id : null,
        userId: a.type === "user" ? a.id : null,
      })));
    }
    await recordAudit(tx, {
      tenantId, actor: auditActorOf(ctx), action: "request.created", entityType: "request", entityId: req!.id,
      requestRef: req!.id, summary: `Created request ${reference} "${input.title}"`,
      after: { reference, title: input.title, taxYear: input.taxYear, dueDate: input.dueDate, priority: input.priority,
        items: input.items.map((i) => i.title), assignees: input.assignees },
    });
    return { id: req!.id, reference };
  });
}

export async function publishRequest(ctx: ServiceContext, requestId: string) {
  assertCan(ctx.session.role, "request.publish");
  return scoped(ctx, async (tx) => {
    const { req, refs } = await loadVisibleRequest(tx, ctx, requestId, true);
    const itemCount = (await tx.select({ n: sql<number>`count(*)::int` }).from(requestItems).where(eq(requestItems.requestId, requestId)))[0]!.n;
    assertCanPublish(req.status, itemCount, refs.length);
    await tx.update(requests).set({ status: "open", publishedAt: new Date(), updatedAt: new Date() }).where(eq(requests.id, requestId));
    await notify(tx, ctx.session.tenantId, await assigneesOfRequest(tx, requestId),
      { type: "request_assigned", title: `New request: ${req.title}`, body: `${req.reference} is due ${req.dueDate}.`, link: `/requests/${requestId}`, dedupeKey: `published:${requestId}` });
    await recordAudit(tx, {
      tenantId: ctx.session.tenantId, actor: auditActorOf(ctx), action: "request.published", entityType: "request",
      entityId: requestId, requestRef: requestId, summary: `Published ${req.reference} to ${refs.length} assignee(s)`,
      before: { status: req.status }, after: { status: "open" },
    });
  });
}

export async function closeRequest(ctx: ServiceContext, requestId: string) {
  assertCan(ctx.session.role, "request.close");
  return scoped(ctx, async (tx) => {
    const { req } = await loadVisibleRequest(tx, ctx, requestId, true);
    assertCanClose(req.status);
    await tx.update(requests).set({ status: "closed", closedAt: new Date(), updatedAt: new Date() }).where(eq(requests.id, requestId));
    await recordAudit(tx, {
      tenantId: ctx.session.tenantId, actor: auditActorOf(ctx), action: "request.closed", entityType: "request",
      entityId: requestId, requestRef: requestId, summary: `Closed ${req.reference}`,
      before: { status: req.status }, after: { status: "closed" },
    });
  });
}

/* ------------------------------------------------------------------ submit / review */

async function syncRequestStatus(tx: Tx, ctx: ServiceContext, req: { id: string; reference: string; status: RequestStatus }) {
  const items = await tx.select({ status: requestItems.status, required: requestItems.required }).from(requestItems).where(eq(requestItems.requestId, req.id));
  const next = deriveRequestStatus(req.status, items);
  if (next === req.status) return;
  await tx.update(requests).set({ status: next, updatedAt: new Date() }).where(eq(requests.id, req.id));
  if (next === "approved") {
    const [full] = await tx.select({ createdBy: requests.createdBy, title: requests.title }).from(requests).where(eq(requests.id, req.id));
    if (full) await notify(tx, ctx.session.tenantId, [full.createdBy], { type: "request_approved", title: `Ready to close: ${full.title}`, body: `${req.reference}: every item is approved.`, link: `/requests/${req.id}`, dedupeKey: `approved:${req.id}` });
  }
  await recordAudit(tx, {
    tenantId: ctx.session.tenantId, actor: auditActorOf(ctx), action: "request.status_changed", entityType: "request",
    entityId: req.id, requestRef: req.id, summary: `${req.reference} moved from “${REQUEST_STATUS_LABELS[req.status]}” to “${REQUEST_STATUS_LABELS[next]}”`,
    before: { status: req.status }, after: { status: next },
  });
}

async function loadItemForUpdate(tx: Tx, ctx: ServiceContext, itemId: string) {
  const [item] = await tx.select().from(requestItems).where(eq(requestItems.id, itemId));
  if (!item) throw new NotFoundError("Item");
  // Lock the parent request first so concurrent item changes serialize and status derivation is consistent.
  const { req } = await loadVisibleRequest(tx, ctx, item.requestId, true);
  const [fresh] = await tx.select().from(requestItems).where(eq(requestItems.id, itemId));
  return { item: fresh!, req };
}

function assertWorkable(status: RequestStatus) {
  if (status === "draft" || status === "closed" || status === "approved") {
    throw new InvalidTransitionError(`This request is ${status} and no longer accepts submissions or reviews.`);
  }
}

export async function submitItem(ctx: ServiceContext, itemId: string, rawInput: unknown, attachments: StoredFile[] = []) {
  assertCan(ctx.session.role, "item.submit");
  const input = submitItemSchema.parse(rawInput);
  return scoped(ctx, async (tx) => {
    const { item, req } = await loadItemForUpdate(tx, ctx, itemId);
    assertWorkable(req.status);
    assertItemTransition(item.status, "submitted");
    const version = ((await tx.select({ n: sql<number>`count(*)::int` }).from(submissions).where(eq(submissions.itemId, itemId)))[0]!.n) + 1;
    const [sub] = await tx.insert(submissions).values({
      tenantId: ctx.session.tenantId, itemId, version, submittedBy: ctx.session.userId, note: input.note,
    }).returning({ id: submissions.id });
    if (attachments.length) {
      await tx.insert(filesTable).values(attachments.map((f) => ({
        id: f.id, tenantId: ctx.session.tenantId, submissionId: sub!.id, originalName: f.name, contentType: f.contentType,
        sizeBytes: f.size, sha256: f.sha256, storageKey: f.storageKey, scanner: f.scanner, scannedAt: f.scannedAt, uploadedBy: ctx.session.userId,
      })));
      // Same transaction as the submission: downstream agents are told about a file only if the submission really committed.
      await tx.insert(jobs).values(attachments.map((f) => ({
        tenantId: ctx.session.tenantId, type: "file.uploaded",
        payload: { fileId: f.id, submissionId: sub!.id, itemId, requestId: req.id, kind: f.kind },
      })));
    }
    await tx.update(requestItems).set({ status: "submitted", updatedAt: new Date() }).where(eq(requestItems.id, itemId));
    await recordAudit(tx, {
      tenantId: ctx.session.tenantId, actor: auditActorOf(ctx), action: "item.submitted", entityType: "request_item",
      entityId: itemId, requestRef: req.id, summary: `Submitted "${item.title}" (v${version}) on ${req.reference}`,
      before: { status: item.status }, after: { status: "submitted", version, note: input.note, files: attachments.map((f) => ({ id: f.id, name: f.name, size: f.size, sha256: f.sha256, scanner: f.scanner })) },
    });
    await notify(tx, ctx.session.tenantId, (await usersWithPermission(tx, "item.review")).map((u) => u.id).filter((id) => id !== ctx.session.userId),
      { type: "submission", title: `Submission to review: ${item.title}`, body: `${req.reference} · v${version}`, link: `/requests/${req.id}#item-${itemId}`, dedupeKey: `submitted:${sub!.id}` });
    await syncRequestStatus(tx, ctx, req);
  });
}

export async function reviewItem(ctx: ServiceContext, itemId: string, rawInput: unknown) {
  assertCan(ctx.session.role, "item.review");
  const input = reviewItemSchema.parse(rawInput);
  return scoped(ctx, async (tx) => {
    const { item, req } = await loadItemForUpdate(tx, ctx, itemId);
    assertWorkable(req.status);
    assertItemTransition(item.status, input.decision);
    const [latest] = await tx.select().from(submissions).where(eq(submissions.itemId, itemId)).orderBy(desc(submissions.version)).limit(1);
    if (!latest) throw new InvalidTransitionError("There is no submission to review.");
    if (violatesSegregationOfDuties(ctx.session.userId, latest.submittedBy)) {
      throw new ForbiddenError("Segregation of duties: you cannot review your own submission.");
    }
    const [rv] = await tx.insert(reviews).values({
      tenantId: ctx.session.tenantId, submissionId: latest.id, reviewerId: ctx.session.userId,
      decision: input.decision, rationale: input.rationale,
    }).returning({ id: reviews.id });
    await notify(tx, ctx.session.tenantId, [latest.submittedBy], {
      type: "review", title: input.decision === "approved" ? `Approved: ${item.title}` : `Changes requested: ${item.title}`,
      body: input.decision === "approved" ? `${req.reference}` : input.rationale, link: `/requests/${req.id}#item-${itemId}`, dedupeKey: `review:${rv!.id}`,
    });
    await tx.update(requestItems).set({ status: input.decision, updatedAt: new Date() }).where(eq(requestItems.id, itemId));
    await recordAudit(tx, {
      tenantId: ctx.session.tenantId, actor: auditActorOf(ctx),
      action: input.decision === "approved" ? "item.approved" : "item.changes_requested",
      entityType: "request_item", entityId: itemId, requestRef: req.id,
      summary: `${input.decision === "approved" ? "Approved" : "Requested changes to"} "${item.title}" on ${req.reference}`,
      before: { status: item.status }, after: { status: input.decision, rationale: input.rationale, submissionVersion: latest.version },
    });
    await syncRequestStatus(tx, ctx, req);
  });
}

/* ------------------------------------------------------------------ comments */

export async function addComment(ctx: ServiceContext, requestId: string, rawInput: unknown) {
  assertCan(ctx.session.role, "comment.create");
  const input = commentSchema.parse(rawInput);
  return scoped(ctx, async (tx) => {
    const { req } = await loadVisibleRequest(tx, ctx, requestId);
    if (req.status === "closed") throw new InvalidTransitionError("This request is closed.");
    if (input.itemId) {
      const [it] = await tx.select({ id: requestItems.id }).from(requestItems)
        .where(and(eq(requestItems.id, input.itemId), eq(requestItems.requestId, requestId)));
      if (!it) throw new NotFoundError("Item");
    }
    const [c] = await tx.insert(comments).values({
      tenantId: ctx.session.tenantId, requestId, itemId: input.itemId ?? null, authorId: ctx.session.userId, body: input.body,
    }).returning({ id: comments.id });
    await recordAudit(tx, {
      tenantId: ctx.session.tenantId, actor: auditActorOf(ctx), action: "comment.added", entityType: "comment",
      entityId: c!.id, requestRef: requestId, summary: `Commented on ${req.reference}`,
      after: { itemId: input.itemId ?? null, body: input.body },
    });
  });
}


/** Edit a DRAFT request in place (title, dates, items, assignees). Published requests are read-only: the database also refuses deletes then. */
export async function updateDraftRequest(ctx: ServiceContext, requestId: string, rawInput: unknown) {
  assertCan(ctx.session.role, "request.update");
  const input = createRequestSchema.parse(rawInput);
  return scoped(ctx, async (tx) => {
    const { req } = await loadVisibleRequest(tx, ctx, requestId, true);
    if (req.status !== "draft") throw new InvalidTransitionError("Only drafts can be edited. A published request is read-only.");
    const tenantId = ctx.session.tenantId;
    const beforeItems = await tx.select({ title: requestItems.title }).from(requestItems).where(eq(requestItems.requestId, requestId)).orderBy(asc(requestItems.position));
    const beforeAssignees = await tx.select({ id: assignments.id }).from(assignments).where(eq(assignments.requestId, requestId));
    try {
      await tx.update(requests).set({ title: input.title, description: input.description, taxYear: input.taxYear, dueDate: input.dueDate, priority: input.priority, updatedAt: new Date() }).where(eq(requests.id, requestId));
      await tx.delete(assignments).where(eq(assignments.requestId, requestId));
      await tx.delete(requestItems).where(eq(requestItems.requestId, requestId));
      if (input.items.length) {
        await tx.insert(requestItems).values(input.items.map((it, i) => ({ tenantId, requestId, position: i + 1, title: it.title, description: it.description, dataType: it.dataType, required: it.required })));
      }
      if (input.assignees.length) {
        await tx.insert(assignments).values(input.assignees.map((a) => ({
          tenantId, requestId, assigneeType: a.type,
          departmentId: a.type === "department" ? a.id : null, entityId: a.type === "entity" ? a.id : null, userId: a.type === "user" ? a.id : null,
        })));
      }
    } catch (e: any) {
      for (let c = e; c; c = c.cause) if (c.code === "23503") throw new InvalidTransitionError("An item that already has comments cannot be removed from the draft.");
      throw e;
    }
    await recordAudit(tx, {
      tenantId, actor: auditActorOf(ctx), action: "request.updated", entityType: "request", entityId: requestId, requestRef: requestId,
      summary: `Edited draft ${req.reference} "${input.title}"`,
      before: { title: req.title, dueDate: req.dueDate, priority: req.priority, items: beforeItems.map((i) => i.title), assignees: beforeAssignees.length },
      after: { title: input.title, dueDate: input.dueDate, priority: input.priority, items: input.items.map((i) => i.title), assignees: input.assignees.length },
    });
    return { id: requestId, reference: req.reference };
  });
}
