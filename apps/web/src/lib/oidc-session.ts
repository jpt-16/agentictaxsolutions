import "server-only";
import { cookies } from "next/headers";
import { jwtVerify, SignJWT } from "jose";
import type { LoginTx } from "./oidc";

const COOKIE = "taxops_oidc_tx";
const key = () => {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new Error("AUTH_SECRET must be at least 32 characters.");
  return new TextEncoder().encode(s);
};

/** The in-flight sign-in (state, nonce, PKCE verifier) lives in a short-lived, signed, HttpOnly cookie scoped to the auth routes. */
export async function saveLoginTx(tx: LoginTx) {
  const token = await new SignJWT({ ...tx }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("10m").sign(key());
  (await cookies()).set(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/auth", maxAge: 600 });
}

export async function takeLoginTx(): Promise<LoginTx | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  jar.delete({ name: COOKIE, path: "/api/auth" }); // single use, even if verification fails
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    return typeof payload.state === "string" && typeof payload.nonce === "string" && typeof payload.verifier === "string"
      ? { state: payload.state, nonce: payload.nonce, verifier: payload.verifier } : null;
  } catch { return null; }
}
