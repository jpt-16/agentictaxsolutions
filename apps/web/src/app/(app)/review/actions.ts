"use server";
import { revalidatePath } from "next/cache";
import { decideProposal, getProposal } from "@taxops/services";
import { requireContext } from "@/lib/auth";
import { guard, type ActionResult } from "@/lib/actions";

export async function decideProposalAction(proposalId: string, decision: "accepted" | "rejected", note: string): Promise<ActionResult> {
  const ctx = await requireContext();
  const r = await guard(() => decideProposal(ctx, proposalId, { decision, note }));
  revalidatePath("/"); revalidatePath("/review"); revalidatePath(`/review/${proposalId}`);
  if (r.ok) {
    const p = await getProposal(ctx, proposalId, { rowLimit: 1 }).catch(() => null);
    if (p) revalidatePath(`/requests/${p.request.id}`);
  }
  return r;
}
