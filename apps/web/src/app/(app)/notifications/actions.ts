"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { markAllRead, markRead } from "@taxops/services";
import { requireContext } from "@/lib/auth";

/** Marks one notification read, then goes to where it points. Only same-site paths are followed (no open redirect). */
export async function openNotification(formData: FormData) {
  const ctx = await requireContext();
  const id = String(formData.get("id") ?? "");
  const link = String(formData.get("link") ?? "/");
  if (/^[0-9a-f-]{36}$/i.test(id)) await markRead(ctx, id);
  revalidatePath("/notifications");
  redirect(link.startsWith("/") && !link.startsWith("//") ? link : "/notifications");
}

export async function markAllReadAction() {
  const ctx = await requireContext();
  await markAllRead(ctx);
  revalidatePath("/notifications"); revalidatePath("/");
}
