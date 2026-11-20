"use server";
import { redirect } from "next/navigation";
import { resolveUserByEmail } from "@taxops/services";
import { db } from "@/lib/db";
import { devAuthEnabled, endSession, startSession } from "@/lib/auth";

export async function signInAs(formData: FormData) {
  if (!devAuthEnabled()) throw new Error("Dev sign-in is disabled.");
  const email = String(formData.get("email") ?? "");
  const found = await resolveUserByEmail(db, email);
  if (!found || !found.isActive) redirect("/login?error=unknown");
  await startSession(found.tenantId, found.userId);
  redirect("/");
}

export async function signOut() {
  await endSession();
  redirect("/login");
}
