"use server";
import { revalidatePath } from "next/cache";
import {
  addComment, closeRequest, createRequest, publishRequest, reviewItem, submitItem,
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

export async function submitItemAction(requestId: string, itemId: string, note: string): Promise<ActionResult> {
  const ctx = await requireContext();
  const r = await guard(() => submitItem(ctx, itemId, { note }));
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
