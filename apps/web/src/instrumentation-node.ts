/** Node-only startup checks (see instrumentation.ts). */
import { checkAuthSecret } from "./lib/auth-secret";

export function assertSafeProductionConfig(): void {
  const problems = [
    checkAuthSecret(process.env.AUTH_SECRET, true),
    process.env.AUTH_MODE !== "oidc" ? "Production requires AUTH_MODE=oidc (single sign-on)." : null,
    process.env.TRUSTED_PROXY_HOPS === undefined ? "Production requires TRUSTED_PROXY_HOPS: 0 if the app is exposed directly, otherwise how many proxies you run in front of it (rate limiting must know whose address to believe)." : null,
    !process.env.CLAMAV_HOST ? "Production requires CLAMAV_HOST: uploads are refused without a malware scanner." : null,
  ].filter(Boolean);
  if (problems.length) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "refusing to start: unsafe production configuration", problems }));
    process.exit(1);
  }
}
