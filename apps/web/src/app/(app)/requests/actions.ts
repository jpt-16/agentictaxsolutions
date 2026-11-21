"use server";
import { revalidatePath } from "next/cache";
import {
  addComment, archiveTemplate, closeRequest, createRequest, createTemplateFromRequest, publishRequest, reviewItem, updateDraftRequest,
} from "@taxops/services";
import { requireContext } from "@/lib/auth";
import { guard, type ActionResult } from "@/lib/actions";

function refresh(requestId?: string) {
  revalidatePath("/");
  revalidatePath("/requests");
  if (requestId) revalidatePath(`/requests/${requestId}`);
}

export async function createRequestAction(
  input: unknown,
  publish: boolean,
): Promise<ActionResult<{ id: string; reference: string; publishError?: string }>> {
  const ctx = await requireContext();
  const created = await guard(() => createRequest(ctx, input));
  if (!created.ok) return created;
  const { id, reference } = created.data!;
  let publishError: string | undefined;
  if (publish) {
    const pub = await guard(() => publishRequest(ctx, id));
    if (!pub.ok) publishError = pub.error;
  }
  refresh(id);
  return { ok: true, data: { id, reference, publishError } };
}

export async function publishRequestAction(requestId: string): Promise<ActionResult> {
  const ctx = await requireContext();
  const r = await guard(() => publishRequest(ctx, requestId));
  refresh(requestId);
  return r;
}

export async function closeRequestAction(requestId: string): Promise<ActionResult> {
  const ctx = await requireContext();
  const r = await guard(() => closeRequest(ctx, requestId));
  refresh(requestId);
  return r;
}

export async function reviewItemAction(
  requestId: string, itemId: string, decision: "approved" | "changes_requested", rationale: string,
): Promise<ActionResult> {
  const ctx = await requireContext();
  const r = await guard(() => reviewItem(ctx, itemId, { decision, rationale }));
  refresh(requestId);
  return r;
}

export async function addCommentAction(requestId: string, body: string, itemId?: string): Promise<ActionResult> {
  const ctx = await requireContext();
  const r = await guard(() => addComment(ctx, requestId, { body, itemId }));
  refresh(requestId);
  return r;
}

export async function updateDraftAction(
  requestId: string, input: unknown, publish: boolean,
): Promise<ActionResult<{ id: string; reference: string; publishError?: string }>> {
  const ctx = await requireContext();
  const saved = await guard(() => updateDraftRequest(ctx, requestId, input));
  if (!saved.ok) return saved;
  let publishError: string | undefined;
  if (publish) {
    const pub = await guard(() => publishRequest(ctx, requestId));
    if (!pub.ok) publishError = pub.error;
  }
  refresh(requestId);
  return { ok: true, data: { id: requestId, reference: saved.data!.reference, publishError } };
}

export async function saveTemplateAction(requestId: string, name: string): Promise<ActionResult> {
  const ctx = await requireContext();
  const r = await guard(() => createTemplateFromRequest(ctx, requestId, name));
  if (r.ok) revalidatePath("/requests/new");
  return r.ok ? { ok: true } : r;
}

export async function archiveTemplateAction(templateId: string): Promise<ActionResult> {
  const ctx = await requireContext();
  const r = await guard(() => archiveTemplate(ctx, templateId));
  revalidatePath("/requests/new");
  return r;
}
