"use server";
import { revalidatePath } from "next/cache";
import { createUser, updateRule, updateTenantSettings, updateUser } from "@taxops/services";
import { requireContext } from "@/lib/auth";
import { guard, type ActionResult } from "@/lib/actions";

export async function updateRuleAction(ruleId: string, enabled: boolean, params: Record<string, string>): Promise<ActionResult> {
  const ctx = await requireContext();
  const r = await guard(() => updateRule(ctx, ruleId, { enabled, params }));
  revalidatePath("/settings");
  return r;
}

export async function updateTenantSettingsAction(aiExtractionEnabled: boolean, externalLlmEnabled: boolean): Promise<ActionResult> {
  const ctx = await requireContext();
  const r = await guard(() => updateTenantSettings(ctx, { aiExtractionEnabled, externalLlmEnabled }));
  revalidatePath("/settings");
  return r;
}

export async function createUserAction(input: unknown): Promise<ActionResult> {
  const ctx = await requireContext();
  const r = await guard(() => createUser(ctx, input));
  revalidatePath("/settings");
  return r;
}

export async function updateUserAction(userId: string, patch: unknown): Promise<ActionResult> {
  const ctx = await requireContext();
  const r = await guard(() => updateUser(ctx, userId, patch));
  revalidatePath("/settings");
  return r;
}
