"use server";
import { revalidatePath } from "next/cache";
import { updateRule } from "@taxops/services";
import { requireContext } from "@/lib/auth";
import { guard, type ActionResult } from "@/lib/actions";

export async function updateRuleAction(ruleId: string, enabled: boolean, params: Record<string, string>): Promise<ActionResult> {
  const ctx = await requireContext();
  const r = await guard(() => updateRule(ctx, ruleId, { enabled, params }));
  revalidatePath("/settings");
  return r;
}
