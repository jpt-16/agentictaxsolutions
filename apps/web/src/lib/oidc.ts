import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";

/**
 * OpenID Connect sign-in (authorization code flow + PKCE). The ID token is verified here: signature against the issuer's keys,
 * issuer, audience, expiry, nonce. Users are matched to EXISTING accounts by verified email; accounts are never created implicitly.
 */
export class OidcError extends Error {
  constructor(readonly code: "config" | "provider" | "state" | "token" | "email", message: string) { super(message); this.name = "OidcError"; }
}

export interface OidcConfig { issuer: string; clientId: string; clientSecret?: string; redirectUri: string; scopes: string; requireVerifiedEmail: boolean }
export interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }
export interface LoginTx { state: string; nonce: string; verifier: string }
export interface Claims { sub: string; email: string; name?: string }
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export function oidcConfigFromEnv(env: Record<string, string | undefined> = process.env): OidcConfig | null {
  if (env.AUTH_MODE !== "oidc") return null;
  const { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: clientId, OIDC_REDIRECT_URI: redirectUri } = env;
  if (!issuer || !clientId || !redirectUri) throw new OidcError("config", "AUTH_MODE=oidc requires OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_REDIRECT_URI.");
  return { issuer: issuer.replace(/\/$/, ""), clientId, clientSecret: env.OIDC_CLIENT_SECRET, redirectUri, scopes: env.OIDC_SCOPES ?? "openid email profile", requireVerifiedEmail: env.OIDC_REQUIRE_VERIFIED_EMAIL !== "false" };
}

const isLocal = (u: URL) => u.hostname === "localhost" || u.hostname === "127.0.0.1";
const secureUrl = (s: string, what: string) => {
  let u: URL;
  try { u = new URL(s); } catch { throw new OidcError("provider", `The identity provider returned an invalid ${what}.`); }
  if (u.protocol !== "https:" && !isLocal(u)) throw new OidcError("provider", `The identity provider's ${what} must use HTTPS.`);
  return u;
};

const cache = new Map<string, { at: number; d: Discovery }>();
export async function discover(cfg: OidcConfig, f: Fetch = fetch): Promise<Discovery> {
  const hit = cache.get(cfg.issuer);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.d;
  secureUrl(cfg.issuer, "issuer");
  const res = await f(`${cfg.issuer}/.well-known/openid-configuration`).catch(() => null);
  if (!res?.ok) throw new OidcError("provider", "Could not reach the identity provider.");
  const d = (await res.json()) as Discovery;
  if (d.issuer?.replace(/\/$/, "") !== cfg.issuer) throw new OidcError("provider", "The identity provider's issuer does not match the configured issuer.");
  for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) secureUrl(d[k], k);
  cache.set(cfg.issuer, { at: Date.now(), d });
  return d;
}
export const _clearDiscoveryCache = () => cache.clear();

const b64url = (b: Buffer) => b.toString("base64url");
export function createAuthRequest(cfg: OidcConfig, d: Discovery): { url: string; tx: LoginTx } {
  const tx: LoginTx = { state: b64url(randomBytes(24)), nonce: b64url(randomBytes(24)), verifier: b64url(randomBytes(48)) };
  const u = new URL(d.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: "code", client_id: cfg.clientId, redirect_uri: cfg.redirectUri, scope: cfg.scopes, state: tx.state, nonce: tx.nonce,
    code_challenge: b64url(createHash("sha256").update(tx.verifier).digest()), code_challenge_method: "S256",
  }).toString();
  return { url: u.toString(), tx };
}

const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export async function completeLogin(cfg: OidcConfig, d: Discovery, params: URLSearchParams, tx: LoginTx, f: Fetch = fetch): Promise<Claims> {
  if (params.get("error")) throw new OidcError("provider", "The identity provider refused the sign-in.");
  const state = params.get("state"), code = params.get("code");
  if (!state || !same(state, tx.state)) throw new OidcError("state", "The sign-in request could not be verified. Please try again.");
  if (!code) throw new OidcError("state", "The sign-in response was incomplete.");

  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri, client_id: cfg.clientId, code_verifier: tx.verifier });
  if (cfg.clientSecret) body.set("client_secret", cfg.clientSecret);
  const res = await f(d.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body }).catch(() => null);
  if (!res?.ok) throw new OidcError("token", "The identity provider did not accept the sign-in.");
  const token = (await res.json()) as { id_token?: string };
  if (!token.id_token) throw new OidcError("token", "The identity provider returned no identity token.");

  const jwksRes = await f(d.jwks_uri).catch(() => null);
  if (!jwksRes?.ok) throw new OidcError("provider", "Could not fetch the identity provider's signing keys.");
  let payload;
  try {
    ({ payload } = await jwtVerify(token.id_token, createLocalJWKSet((await jwksRes.json()) as JSONWebKeySet), {
      issuer: cfg.issuer, audience: cfg.clientId, algorithms: ["RS256", "RS384", "RS512", "ES256", "ES384", "PS256"], clockTolerance: 30,
    }));
  } catch { throw new OidcError("token", "The identity token could not be verified."); }
  if (typeof payload.nonce !== "string" || !same(payload.nonce, tx.nonce)) throw new OidcError("token", "The identity token does not belong to this sign-in.");
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email) throw new OidcError("email", "The identity provider did not share an email address.");
  if (cfg.requireVerifiedEmail && payload.email_verified !== true) throw new OidcError("email", "Your email address is not verified with the identity provider.");
  return { sub: String(payload.sub), email, name: typeof payload.name === "string" ? payload.name : undefined };
}
