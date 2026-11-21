import { and, asc, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import {
  assertCan, can, decideProposalSchema, documentPayloadSchema, extractionPayloadSchema, findingPayloadSchema, InvalidTransitionError, remapSchema,
  type DocumentPayload, type ExtractionPayload, type FindingPayload, type ProposalStatus,
} from "@taxops/core";
import {
  agentRuns, extractedRows, files, jobs, proposals, recordAudit, requestItems, requests, submissions, tenants, users, type Tx,
} from "@taxops/db";
import { auditActorOf, NotFoundError, scoped, type ServiceContext } from "./context";
import { reviewItem } from "./requests";

export interface ProposalFilters {
  kind?: "extraction" | "finding";
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
    if (f.kind) conds.push(eq(proposals.kind, f.kind));
    const where = and(...conds);
    const rows = await tx
      .select({
        id: proposals.id, kind: proposals.kind, ruleId: proposals.ruleId, title: proposals.title, detail: proposals.detail, confidence: proposals.confidence, severity: proposals.severity,
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
    const parsed = p.kind === "extraction" ? extractionPayloadSchema.safeParse(p.payload) : null;
    const parsedDoc = p.kind === "extraction" && p.schemaKey === "supporting_document" ? documentPayloadSchema.safeParse(p.payload) : null;
    const parsedFinding = p.kind === "finding" ? findingPayloadSchema.safeParse(p.payload) : null;
    const [source] = p.sourceProposalId ? await tx.select({ id: proposals.id, title: proposals.title }).from(proposals).where(eq(proposals.id, p.sourceProposalId)) : [];
    const findings = p.kind === "extraction" ? await findingsForSource(tx, p.id) : [];

    return {
      id: p.id, title: p.title, detail: p.detail, kind: p.kind, status: p.status, severity: p.severity, confidence: Number(p.confidence),
      createdAt: p.createdAt, decidedAt: p.decidedAt, decidedByName: decider?.name ?? null, decisionNote: p.decisionNote,
      ruleId: p.ruleId,
      payload: parsed?.success ? (parsed.data as ExtractionPayload) : null, // null => payload did not match the contract
      document: parsedDoc?.success ? (parsedDoc.data as DocumentPayload) : null,
      isDocument: p.schemaKey === "supporting_document",
      finding: parsedFinding?.success ? (parsedFinding.data as FindingPayload) : null,
      source: source ?? null, findings,
      request: { id: req!.id, reference: req!.reference, title: req!.title },
      item: { id: item!.id, title: item!.title },
      file: { id: file!.id, name: file!.name, size: file!.size, previewable: /\.(xlsx|csv)$/i.test(file!.name) },
      submission: { version: sub?.version ?? 0, by: sub?.by ?? "Unknown" },
      run: run ? { agent: run.agentName, version: run.agentVersion, model: run.model, promptVersion: run.promptVersion, llmCalls: run.llmCalls, durationMs: run.durationMs } : null,
      rows: rows as { position: number; sheet: string; sourceRow: number; values: Record<string, string>; cells: Record<string, string>; issues: string[] }[],
      totalRows, rowOffset, rowLimit,
      can: {
        decide: can(ctx.session.role, "proposal.review") && p.status === "pending",
        sendBack: p.kind === "finding" && p.status === "accepted" && can(ctx.session.role, "item.review") && item?.status === "submitted",
      },
    };
  });
}

export interface FindingSummary { id: string; title: string; severity: "info" | "warning" | "error" | null; status: ProposalStatus; ruleId: string | null }

/** Findings raised against one accepted extraction (excluding superseded ones). */
export async function findingsForSource(tx: Tx, sourceId: string): Promise<FindingSummary[]> {
  const rows = await tx.select({ id: proposals.id, title: proposals.title, severity: proposals.severity, status: proposals.status, ruleId: proposals.ruleId })
    .from(proposals).where(and(eq(proposals.sourceProposalId, sourceId), ne(proposals.status, "superseded"))).orderBy(asc(proposals.createdAt));
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return rows.sort((a, b) => rank[a.severity ?? "info"] - rank[b.severity ?? "info"]);
}

/** Open (pending) and confirmed findings for a whole request, for the validation card on the request page. */
export async function findingsForRequest(tx: Tx, ctx: ServiceContext, requestId: string) {
  if (!can(ctx.session.role, "proposal.read")) return null;
  const rows = await tx.select({ id: proposals.id, title: proposals.title, severity: proposals.severity, status: proposals.status, ruleId: proposals.ruleId })
    .from(proposals).where(and(eq(proposals.requestId, requestId), eq(proposals.kind, "finding"), ne(proposals.status, "superseded"))).orderBy(asc(proposals.createdAt));
  const count = (st: ProposalStatus) => rows.filter((r) => r.status === st).length;
  return { open: count("pending"), confirmed: count("accepted"), dismissed: count("rejected"), openErrors: rows.filter((r) => r.status === "pending" && r.severity === "error").length, items: rows.filter((r) => r.status !== "rejected") };
}

/**
 * After a person CONFIRMS a finding, send the item back to the contributor with the finding as the reason.
 * Uses the normal review path, so permissions, segregation of duties, status rules and audit all apply unchanged.
 */
export async function requestChangesFromFinding(ctx: ServiceContext, findingId: string) {
  assertCan(ctx.session.role, "proposal.review");
  assertCan(ctx.session.role, "item.review");
  const f = await getProposal(ctx, findingId, { rowLimit: 1 });
  if (f.kind !== "finding" || f.status !== "accepted") throw new InvalidTransitionError("Only a confirmed finding can be sent back to the contributor.");
  const summary = f.finding?.summary ?? f.detail;
  const rationale = `Validation finding: ${f.title}. ${summary} ${f.finding?.suggestion ?? ""}`.trim().slice(0, 1900);
  await reviewItem(ctx, f.item.id, { decision: "changes_requested", rationale });
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
    // Validation rules exist only for trial balances; an accepted supporting document has nothing further to run.
    if (p.kind === "extraction" && input.decision === "accepted" && (p.schemaKey ?? "trial_balance") === "trial_balance") {
      // Same transaction as the decision: validation runs only against data a person has accepted, and never gets lost.
      await tx.insert(jobs).values({
        tenantId: ctx.session.tenantId, type: "proposal.accepted",
        payload: { proposalId: p.id, fileId: p.fileId, requestId: p.requestId, itemId: p.itemId, schema: p.schemaKey ?? "trial_balance" },
      });
    }
    await recordAudit(tx, {
      tenantId: ctx.session.tenantId, actor: auditActorOf(ctx), action: `proposal.${input.decision}`, entityType: "proposal", entityId: p.id,
      requestRef: p.requestId,
      summary: p.kind === "finding"
        ? `${input.decision === "accepted" ? "Confirmed" : "Dismissed"} finding "${p.title}" on ${req?.reference ?? ""}`
        : `${input.decision === "accepted" ? "Accepted" : "Rejected"} AI result "${p.title}" on ${req?.reference ?? ""}`,
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
    .where(and(inArray(proposals.fileId, fileIds), eq(proposals.kind, "extraction"), ne(proposals.status, "superseded"))).orderBy(asc(proposals.createdAt));
  const runs = await tx.select({ fileId: agentRuns.fileId, status: agentRuns.status, detail: agentRuns.detail }).from(agentRuns)
    .where(and(inArray(agentRuns.fileId, fileIds), inArray(agentRuns.agentName, ["extraction", "extraction_remap"]))).orderBy(desc(agentRuns.createdAt));
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


/**
 * A reviewer corrected the column mapping of a PENDING extraction: queue a deterministic re-extraction of that sheet.
 * The worker verifies the mapping against the data and supersedes the pending proposal; nothing is applied here.
 */
/** The tenant's "AI extraction" switch governs every agent that reads uploaded files, including reviewer-directed re-extraction. */
async function assertAiEnabled(tx: Tx) {
  const [t] = await tx.select({ on: tenants.aiExtractionEnabled }).from(tenants);
  if (!t?.on) throw new InvalidTransitionError("AI extraction is switched off for your organization. A tenant admin can turn it on in Settings.");
}

export async function requestRemap(ctx: ServiceContext, proposalId: string, rawInput: unknown) {
  assertCan(ctx.session.role, "proposal.review");
  const input = remapSchema.parse(rawInput);
  return scoped(ctx, async (tx) => {
    const [p] = await tx.select().from(proposals).where(eq(proposals.id, proposalId));
    if (!p || p.kind !== "extraction") throw new NotFoundError("Proposal");
    await assertAiEnabled(tx); // after the existence check, so "not found" never depends on the caller's own settings
    if (p.status !== "pending") throw new InvalidTransitionError("Only a result that is still awaiting review can be re-extracted.");
    const payload = extractionPayloadSchema.safeParse(p.payload);
    if (!payload.success) throw new InvalidTransitionError("This result is not in a readable format.");
    const [file] = await tx.select({ name: files.originalName, submissionId: files.submissionId }).from(files).where(eq(files.id, p.fileId));
    const kind = /\.csv$/i.test(file!.name) ? "csv" : "xlsx";
    const columns = Object.fromEntries(Object.entries(input.columns).map(([k, v]) => [k, v.toUpperCase()]));
    await tx.insert(jobs).values({
      tenantId: ctx.session.tenantId, type: "extraction.remap",
      payload: { fileId: p.fileId, submissionId: file!.submissionId, itemId: p.itemId, requestId: p.requestId, kind, sheet: payload.data.sheet, headerRow: input.headerRow, columns, requestedBy: ctx.session.userId },
    });
    await recordAudit(tx, {
      tenantId: ctx.session.tenantId, actor: auditActorOf(ctx), action: "proposal.remap_requested", entityType: "proposal", entityId: p.id, requestRef: p.requestId,
      summary: `Corrected the column mapping of "${p.title}" and requested re-extraction`,
      before: { headerRow: payload.data.header_row, columns: payload.data.columns }, after: { headerRow: input.headerRow, columns },
    });
  });
}

/** Queue extraction again for a file (e.g. after the worker was down, or a failed run). Supersedes pending output for each sheet. */
export async function reprocessFile(ctx: ServiceContext, fileId: string) {
  assertCan(ctx.session.role, "proposal.review");
  return scoped(ctx, async (tx) => {
    const [f] = await tx.select({ id: files.id, name: files.originalName, submissionId: files.submissionId }).from(files).where(eq(files.id, fileId));
    if (!f) throw new NotFoundError("File");
    await assertAiEnabled(tx);
    const [sub] = await tx.select({ itemId: submissions.itemId }).from(submissions).where(eq(submissions.id, f.submissionId));
    const [item] = await tx.select({ requestId: requestItems.requestId }).from(requestItems).where(eq(requestItems.id, sub!.itemId));
    const ext = (f.name.split(".").pop() ?? "").toLowerCase();
    if (ext !== "xlsx" && ext !== "csv") throw new InvalidTransitionError("Only spreadsheets can be processed.");
    await tx.insert(jobs).values({
      tenantId: ctx.session.tenantId, type: "file.uploaded",
      payload: { fileId: f.id, submissionId: f.submissionId, itemId: sub!.itemId, requestId: item!.requestId, kind: ext },
    });
    await recordAudit(tx, {
      tenantId: ctx.session.tenantId, actor: auditActorOf(ctx), action: "file.reprocess_requested", entityType: "file", entityId: f.id, requestRef: item!.requestId,
      summary: `Requested AI processing again for "${f.name}"`, after: { fileId: f.id },
    });
  });
}

/** Whether AI work is queued or running for a file (so the UI can say "in progress" instead of looking stuck). */
export async function pendingWorkForFile(ctx: ServiceContext, fileId: string): Promise<number> {
  if (!can(ctx.session.role, "proposal.read")) return 0;
  return scoped(ctx, async (tx) => (await tx.select({ n: sql<number>`count(*)::int` }).from(jobs)
    .where(and(sql`${jobs.payload}->>'fileId' = ${fileId}`, inArray(jobs.status, ["queued", "running"]), inArray(jobs.type, ["file.uploaded", "extraction.remap"]))))[0]!.n);
}
