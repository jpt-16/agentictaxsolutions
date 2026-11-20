import { NextResponse } from "next/server";
import { discover, createAuthRequest, oidcConfigFromEnv } from "@/lib/oidc";
import { saveLoginTx } from "@/lib/oidc-session";
import { clientKey, limiter, tooMany } from "@/lib/rate-limit";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const rl = limiter("auth", 20, 60_000).hit(clientKey(req.headers));
  if (!rl.ok) return tooMany(rl.retryAfterSec);
  let cfg;
  try { cfg = oidcConfigFromEnv(); } catch (e) { log.error("oidc misconfigured", { error: e }); return new Response("Single sign-on is not configured.", { status: 500 }); }
  if (!cfg) return new Response("Not found", { status: 404 });
  try {
    const { url, tx } = createAuthRequest(cfg, await discover(cfg));
    await saveLoginTx(tx);
    return NextResponse.redirect(url, 302);
  } catch (e) {
    log.error("oidc login start failed", { error: e });
    return NextResponse.redirect(new URL("/login?error=sso", cfg.redirectUri), 302);
  }
}
