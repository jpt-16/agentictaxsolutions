import { and, asc, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import {
  assertCan, can, decideProposalSchema, extractionPayloadSchema, InvalidTransitionError, type ExtractionPayload, type ProposalStatus,
} from "@taxops/core";
import {
  agentRuns, extractedRows, files, proposals, recordAudit, requestItems, requests, submissions, users, type Tx,
} from "@taxops/db";
import { auditActorOf, NotFoundError, scoped, type ServiceContext } from "./context";

export interface ProposalFilters {
  status?: ProposalStatus | "all";
  requestId?: string;
  limit?: number;
  offset?: number;
}

/** Roles that may see AI output also see every request in the tenant, so no per-request scoping is needed here. */
export async function listProposals(ctx: ServiceContext, f: ProposalFilters = {}) {
  assertCan(ctx.session.role, "proposal.read");
  return scoped(ctx, async (tx) => {
    const status = f.status ?? "pending";
    const conds: (SQL | undefined)[] = [status === "all" ? ne(proposals.status, "superseded") : eq(proposals.status, status)];
    if (f.requestId) conds.push(eq(proposals.requestId, f.requestId));
    const where = and(...conds);
    const rows = await tx
      .select({
        id: proposals.id, title: proposals.title, detail: proposals.detail, confidence: proposals.confidence, severity: proposals.severity,
        status: proposals.status, createdAt: proposals.createdAt, decidedAt: proposals.decidedAt,
        requestId: requests.id, requestRef: requests.reference, requestTitle: requests.title, itemTitle: requestItems.title,
        fileName: files.originalName, rowCount: sql<number>`(select count(*)::int from extracted_rows er where er.proposal_id = ${proposals.id})`,
      })
      .from(proposals)
      .innerJoin(requests, and(eq(requests.tenantId, proposals.tenantId), eq(requests.id, proposals.requestId)))
      .innerJoin(requestItems, and(eq(requestItems.tenantId, proposals.tenantId), eq(requestItems.id, proposals.itemId)))
      .innerJoin(files, and(eq(files.tenantId, proposals.tenantId), eq(files.id, proposals.fileId)))
      .where(where)
      .orderBy(status === "pending" ? asc(proposals.createdAt) : desc(proposals.decidedAt), asc(proposals.title))
      .limit(Math.min(f.limit ?? 50, 200)).offset(f.offset ?? 0);
    const total = (await tx.select({ n: sql<number>`count(*)::int` }).from(proposals).where(where))[0]!.n;
    return { rows: rows.map((r) => ({ ...r, confidence: Number(r.confidence) })), total };
  });
}

export async function pendingProposalCount(ctx: ServiceContext): Promise<number> {
  if (!can(ctx.session.role, "proposal.read")) return 0;
  return scoped(ctx, async (tx) => (await tx.select({ n: sql<number>`count(*)::int` }).from(proposals).where(eq(proposals.status, "pending")))[0]!.n);
}

export async function getProposal(ctx: ServiceContext, proposalId: string, opts: { rowOffset?: number; rowLimit?: number } = {}) {
  assertCan(ctx.session.role, "proposal.read");
  return scoped(ctx, async (tx) => {
    const [p] = await tx.select().from(proposals).where(eq(proposals.id, proposalId));
    if (!p) throw new NotFoundError("Proposal");
    const [req] = await tx.select().from(requests).where(eq(requests.id, p.requestId));
    const [item] = await tx.select().from(requestItems).where(eq(requestItems.id, p.itemId));
    const [file] = await tx.select({
      id: files.id, name: files.originalName, contentType: files.contentType, size: files.sizeBytes, sha256: files.sha256, submissionId: files.submissionId,
    }).from(files).where(eq(files.id, p.fileId));
    const [sub] = await tx.select({ version: submissions.version, by: users.name }).from(submissions)
      .innerJoin(users, and(eq(users.tenantId, submissions.tenantId), eq(users.id, submissions.submittedBy))).where(eq(submissions.id, file!.submissionId));
    const [run] = await tx.select().from(agentRuns).where(eq(agentRuns.id, p.runId));
    const [decider] = p.decidedBy ? await tx.select({ name: users.name }).from(users).where(eq(users.id, p.decidedBy)) : [];
    const rowLimit = Math.min(opts.rowLimit ?? 100, 500), rowOffset = opts.rowOffset ?? 0;
    const rows = await tx.select({
      position: extractedRows.position, sheet: extractedRows.sheet, sourceRow: extractedRows.sourceRow,
      values: extractedRows.values, cells: extractedRows.cells, issues: extractedRows.issues,
    }).from(extractedRows).where(eq(extractedRows.proposalId, p.id)).orderBy(asc(extractedRows.position)).limit(rowLimit).offset(rowOffset);
    const totalRows = (await tx.select({ n: sql<number>`count(*)::int` }).from(extractedRows).where(eq(extractedRows.proposalId, p.id)))[0]!.n;
    const parsed = extractionPayloadSchema.safeParse(p.payload);

    return {
      id: p.id, title: p.title, detail: p.detail, kind: p.kind, status: p.status, severity: p.severity, confidence: Number(p.confidence),
      createdAt: p.createdAt, decidedAt: p.decidedAt, decidedByName: decider?.name ?? null, decisionNote: p.decisionNote,
      payload: parsed.success ? (parsed.data as ExtractionPayload) : null, // null => payload did not match the contract
      request: { id: req!.id, reference: req!.reference, title: req!.title },
      item: { id: item!.id, title: item!.title },
      file: { id: file!.id, name: file!.name, size: file!.size, previewable: /\.(xlsx|csv)$/i.test(file!.name) },
      submission: { version: sub?.version ?? 0, by: sub?.by ?? "Unknown" },
      run: run ? { agent: run.agentName, version: run.agentVersion, model: run.model, promptVersion: run.promptVersion, llmCalls: run.llmCalls, durationMs: run.durationMs } : null,
      rows: rows as { position: number; sheet: string; sourceRow: number; values: Record<string, string>; cells: Record<string, string>; issues: string[] }[],
      totalRows, rowOffset, rowLimit,
      can: { decide: can(ctx.session.role, "proposal.review") && p.status === "pending" },
    };
  });
}

/** A human accepts or rejects an AI proposal. The decision is final (also enforced by a database trigger). */
export async function decideProposal(ctx: ServiceContext, proposalId: string, rawInput: unknown) {
  assertCan(ctx.session.role, "proposal.review");
  const input = decideProposalSchema.parse(rawInput);
  return scoped(ctx, async (tx) => {
    const [p] = await tx.select().from(proposals).where(eq(proposals.id, proposalId));
    if (!p) throw new NotFoundError("Proposal");
    // Conditional update: if two reviewers click at once, exactly one wins.
    const updated = await tx.update(proposals).set({
      status: input.decision, decidedBy: ctx.session.userId, decidedAt: new Date(), decisionNote: input.note || null,
    }).where(and(eq(proposals.id, proposalId), eq(proposals.status, "pending"))).returning({ id: proposals.id });
    if (updated.length === 0) throw new InvalidTransitionError(`This result was already ${p.status}.`);
    const [req] = await tx.select({ reference: requests.reference }).from(requests).where(eq(requests.id, p.requestId));
    await recordAudit(tx, {
      tenantId: ctx.session.tenantId, actor: auditActorOf(ctx), action: `proposal.${input.decision}`, entityType: "proposal", entityId: p.id,
      requestRef: p.requestId,
      summary: `${input.decision === "accepted" ? "Accepted" : "Rejected"} AI result "${p.title}" on ${req?.reference ?? ""}`,
      before: { status: "pending", confidence: Number(p.confidence) },
      after: { status: input.decision, note: input.note || null },
    });
  });
}

export type ExtractionState = "queued" | "review" | "accepted" | "rejected" | "none" | "skipped" | "failed";
export interface FileExtraction { state: ExtractionState; pending: number; accepted: number; rejected: number; detail?: string; firstProposalId?: string }

/** Where each file stands in the AI pipeline, for badges on the request page. Null for roles that may not see AI output. */
export async function extractionByFile(tx: Tx, ctx: ServiceContext, fileIds: string[]): Promise<Map<string, FileExtraction> | null> {
  if (!can(ctx.session.role, "proposal.read")) return null;
  const out = new Map<string, FileExtraction>();
  if (fileIds.length === 0) return out;
  const props = await tx.select({ id: proposals.id, fileId: proposals.fileId, status: proposals.status }).from(proposals)
    .where(and(inArray(proposals.fileId, fileIds), ne(proposals.status, "superseded"))).orderBy(asc(proposals.createdAt));
  const runs = await tx.select({ fileId: agentRuns.fileId, status: agentRuns.status, detail: agentRuns.detail }).from(agentRuns)
    .where(inArray(agentRuns.fileId, fileIds)).orderBy(desc(agentRuns.createdAt));
  for (const id of fileIds) {
    const mine = props.filter((p) => p.fileId === id);
    const c = { pending: mine.filter((p) => p.status === "pending").length, accepted: mine.filter((p) => p.status === "accepted").length, rejected: mine.filter((p) => p.status === "rejected").length };
    if (mine.length) {
      const state: ExtractionState = c.pending ? "review" : c.accepted ? "accepted" : "rejected";
      out.set(id, { state, ...c, firstProposalId: (mine.find((p) => p.status === "pending") ?? mine[0])!.id });
      continue;
    }
    const run = runs.find((r) => r.fileId === id);
    out.set(id, !run ? { state: "queued", ...c } : { state: run.status === "skipped" ? "skipped" : run.status === "failed" ? "failed" : "none", ...c, detail: run.detail });
  }
  return out;
}
