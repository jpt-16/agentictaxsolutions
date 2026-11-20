import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { jwtVerify, SignJWT } from "jose";
import { loadSession, type ServiceContext } from "@taxops/services";
import { db } from "./db";
import { checkAuthSecret } from "./auth-secret";

const COOKIE = "taxops_session";
const MAX_AGE_SECONDS = 60 * 60 * 8;

/**
 * Phase 0/1 authentication is a DEVELOPMENT stub: it lists the fictional demo users and signs one in
 * without a password. It is hard-disabled in production. Real SSO (OIDC/SAML) replaces `signInAs`
 * in a later phase; everything downstream only depends on the session cookie + loadSession().
 */
export function devAuthEnabled(): boolean {
  return process.env.AUTH_MODE === "dev" && process.env.NODE_ENV !== "production";
}

export function ssoEnabled(): boolean {
  return process.env.AUTH_MODE === "oidc";
}

export function assertAuthConfig() {
  if (process.env.AUTH_MODE === "dev" && process.env.NODE_ENV === "production") {
    throw new Error("AUTH_MODE=dev is not allowed in production.");
  }
  if (process.env.NODE_ENV === "production" && process.env.AUTH_MODE !== "oidc") {
    throw new Error("Production requires AUTH_MODE=oidc (single sign-on).");
  }
}

function secretKey(): Uint8Array {
  const s = process.env.AUTH_SECRET;
  const problem = checkAuthSecret(s, process.env.NODE_ENV === "production");
  if (problem) throw new Error(problem);
  return new TextEncoder().encode(s!);
}

export async function startSession(tenantId: string, userId: string) {
  assertAuthConfig();
  const token = await new SignJWT({ tid: tenantId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secretKey());
  (await cookies()).set(COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: MAX_AGE_SECONDS,
  });
}

export async function endSession() {
  (await cookies()).delete(COOKIE);
}

/** The token only says WHO; role, scope and active-state are always re-read from the database. */
export async function getContext(): Promise<ServiceContext | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    if (!payload.sub || typeof payload.tid !== "string") return null;
    const session = await loadSession(db, payload.tid, payload.sub);
    return session ? { db, session } : null;
  } catch {
    return null;
  }
}

export async function requireContext(): Promise<ServiceContext> {
  const ctx = await getContext();
  if (!ctx) redirect("/login");
  return ctx;
}
