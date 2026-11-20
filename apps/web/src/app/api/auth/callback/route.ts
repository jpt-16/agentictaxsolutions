import { NextResponse } from "next/server";
import { recordLogin, resolveUserByEmail } from "@taxops/services";
import { startSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { completeLogin, discover, oidcConfigFromEnv, OidcError } from "@/lib/oidc";
import { takeLoginTx } from "@/lib/oidc-session";
import { clientKey, limiter, tooMany } from "@/lib/rate-limit";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const rl = limiter("auth", 20, 60_000).hit(clientKey(req.headers));
  if (!rl.ok) return tooMany(rl.retryAfterSec);
  const cfg = oidcConfigFromEnv();
  if (!cfg) return new Response("Not found", { status: 404 });
  const back = (reason: string) => NextResponse.redirect(new URL(`/login?error=${reason}`, cfg.redirectUri), 302);
  const tx = await takeLoginTx();
  if (!tx) return back("sso");
  try {
    const claims = await completeLogin(cfg, await discover(cfg), new URL(req.url).searchParams, tx);
    const user = await resolveUserByEmail(db, claims.email);
    // Accounts are NEVER created implicitly: the person must already exist in a tenant (provisioned by an admin / SCIM later).
    if (!user || !user.isActive) { log.warn("sso login for unknown or inactive account"); return back("no-account"); }
    await startSession(user.tenantId, user.userId);
    await recordLogin(db, user.tenantId, user.userId, "sso");
    log.info("sso login", { tenantId: user.tenantId, userId: user.userId });
    return NextResponse.redirect(new URL("/", cfg.redirectUri), 302);
  } catch (e) {
    log.warn("sso login failed", { code: e instanceof OidcError ? e.code : "unexpected", error: e instanceof OidcError ? e.message : String(e) });
    return back(e instanceof OidcError && e.code === "email" ? "email" : "sso");
  }
}
