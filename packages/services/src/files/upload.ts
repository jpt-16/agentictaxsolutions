import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { assertCan } from "@taxops/core";
import { files, recordAudit, requestItems, submissions } from "@taxops/db";
import { auditActorOf, NotFoundError, scoped, type ServiceContext } from "../context";
import { loadVisibleRequest, submitItem } from "../requests";
import { previewSpreadsheet, type SheetPreview } from "./preview";
import { ScanUnavailableError, type Scanner } from "./scanner";
import { storageKey, type FileStorage } from "./storage";
import type { StoredFile } from "./types";
import {
  MAX_FILES_PER_SUBMISSION, MAX_TOTAL_BYTES, UploadRejectedError, isPreviewable, kindOfContentType, validateUpload, type FileKind,
} from "./validate";

export interface FileDeps { storage: FileStorage; scanner: Scanner }
export interface Upload { name: string; bytes: Buffer }

/**
 * Submits an item together with its files.
 * Order matters for safety: authorize → validate → malware-scan → write blobs → commit DB rows + audit + jobs.
 * If the commit fails the blobs are deleted. A file that fails validation or scanning blocks the WHOLE submission
 * (all-or-nothing), is never stored, and is recorded in the audit trail as `file.rejected`.
 */
export async function submitWithFiles(ctx: ServiceContext, deps: FileDeps, itemId: string, rawInput: unknown, uploads: Upload[]) {
  assertCan(ctx.session.role, "item.submit");
  if (uploads.length > MAX_FILES_PER_SUBMISSION) throw new UploadRejectedError(`Attach at most ${MAX_FILES_PER_SUBMISSION} files per submission.`);
  if (uploads.reduce((n, u) => n + u.bytes.length, 0) > MAX_TOTAL_BYTES) throw new UploadRejectedError("The files are larger than 100 MB in total.");

  // Fail fast (before any scanning/storage) if this person may not submit to this item right now.
  const context = await scoped(ctx, async (tx) => {
    const [item] = await tx.select().from(requestItems).where(eq(requestItems.id, itemId));
    if (!item) throw new NotFoundError("Item");
    const { req } = await loadVisibleRequest(tx, ctx, item.requestId);
    return { requestId: req.id, reference: req.reference, itemTitle: item.title };
  });

  const stored: StoredFile[] = [];
  const rejected: { file: string; reason: string; detail?: string }[] = [];
  const scannedAt = new Date();
  const pending: { id: string; upload: Upload; meta: ReturnType<typeof validateUpload> }[] = [];

  for (const upload of uploads) {
    try {
      pending.push({ id: randomUUID(), upload, meta: validateUpload(upload.name, upload.bytes) });
    } catch (e) {
      rejected.push({ file: upload.name.slice(0, 200), reason: (e as Error).message });
    }
  }
  for (const p of pending) {
    try {
      const result = await deps.scanner.scan(p.upload.bytes);
      if (!result.clean) rejected.push({ file: p.meta.safeName, reason: "This file was blocked by the virus scan.", detail: `signature: ${result.signature ?? "unknown"}` });
    } catch (e) {
      if (!(e instanceof ScanUnavailableError)) throw e;
      rejected.push({ file: p.meta.safeName, reason: "Files cannot be scanned right now. Please try again shortly.", detail: "scanner unavailable" });
    }
  }

  if (rejected.length) {
    await scoped(ctx, async (tx) => {
      for (const r of rejected) {
        await recordAudit(tx, {
          tenantId: ctx.session.tenantId, actor: auditActorOf(ctx), action: "file.rejected", entityType: "request_item",
          entityId: itemId, requestRef: context.requestId, summary: `Rejected upload "${r.file}" for "${context.itemTitle}" on ${context.reference}`,
          after: { file: r.file, reason: r.reason, detail: r.detail ?? null },
        });
      }
    });
    throw new UploadRejectedError(
      rejected.length === 1 ? rejected[0]!.reason : "Some files could not be accepted. Nothing was submitted.",
      rejected.map((r) => ({ file: r.file, reason: r.reason })),
    );
  }

  const written: string[] = [];
  try {
    for (const p of pending) {
      const key = storageKey(ctx.session.tenantId, p.id);
      await deps.storage.put(key, p.upload.bytes);
      written.push(key);
      stored.push({ id: p.id, name: p.meta.safeName, kind: p.meta.kind, contentType: p.meta.contentType, size: p.meta.size, sha256: p.meta.sha256, storageKey: key, scanner: deps.scanner.name, scannedAt });
    }
    await submitItem(ctx, itemId, rawInput, stored);
  } catch (e) {
    await Promise.allSettled(written.map((k) => deps.storage.delete(k)));
    throw e;
  }
  return { files: stored.length };
}

interface FileAccess { id: string; name: string; contentType: string; size: number; sha256: string; storageKey: string; kind: FileKind | null }

/** Re-authorizes on EVERY access (no bearer links) and records who opened which file. */
async function authorize(ctx: ServiceContext, fileId: string, mode: "download" | "view"): Promise<FileAccess> {
  assertCan(ctx.session.role, "dashboard.read");
  return scoped(ctx, async (tx) => {
    const [row] = await tx
      .select({ f: files, itemId: submissions.itemId })
      .from(files).innerJoin(submissions, eq(submissions.id, files.submissionId)).where(eq(files.id, fileId));
    if (!row) throw new NotFoundError("File");
    const [item] = await tx.select({ requestId: requestItems.requestId }).from(requestItems).where(eq(requestItems.id, row.itemId));
    const { req } = await loadVisibleRequest(tx, ctx, item!.requestId); // throws NotFound if the caller can't see the request
    await recordAudit(tx, {
      tenantId: ctx.session.tenantId, actor: auditActorOf(ctx), action: mode === "download" ? "file.downloaded" : "file.viewed",
      entityType: "file", entityId: row.f.id, requestRef: req.id,
      summary: `${mode === "download" ? "Downloaded" : "Viewed"} "${row.f.originalName}" on ${req.reference}`,
      after: { name: row.f.originalName, sha256: row.f.sha256 },
    });
    return { id: row.f.id, name: row.f.originalName, contentType: row.f.contentType, size: row.f.sizeBytes, sha256: row.f.sha256, storageKey: row.f.storageKey, kind: kindOfContentType(row.f.contentType) };
  });
}

async function readVerified(deps: FileDeps, meta: FileAccess): Promise<Buffer> {
  const bytes = await deps.storage.get(meta.storageKey);
  if (createHash("sha256").update(bytes).digest("hex") !== meta.sha256) throw new Error(`Stored file ${meta.id} failed its integrity check.`);
  return bytes;
}

export async function downloadFile(ctx: ServiceContext, deps: FileDeps, fileId: string) {
  const meta = await authorize(ctx, fileId, "download");
  return { name: meta.name, contentType: meta.contentType, size: meta.size, bytes: await readVerified(deps, meta) };
}

export async function previewFile(ctx: ServiceContext, deps: FileDeps, fileId: string, sheet?: string): Promise<{ name: string; size: number; preview: SheetPreview }> {
  const meta = await authorize(ctx, fileId, "view");
  if (!meta.kind || !isPreviewable(meta.kind)) throw new UploadRejectedError("Preview is only available for spreadsheets.");
  return { name: meta.name, size: meta.size, preview: await previewSpreadsheet(await readVerified(deps, meta), meta.kind, sheet) };
}
