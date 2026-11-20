import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { OidcError, _clearDiscoveryCache, completeLogin, createAuthRequest, discover, oidcConfigFromEnv, type OidcConfig } from "./oidc";

/** A minimal identity provider that enforces what a real one would: PKCE, single-use codes, client secret, redirect URI. */
let server: http.Server, base: string, cfg: OidcConfig;
let privateKey: CryptoKey, publicJwk: JWK, otherKey: CryptoKey;
const codes = new Map<string, { challenge: string; nonce: string; claims: Record<string, unknown>; redirect: string }>();
let tokenOverride: ((claims: Record<string, unknown>) => Promise<string>) | null = null;
let issuerOverride: string | null = null;

async function sign(claims: Record<string, unknown>, o: { key?: CryptoKey; iss?: string; aud?: string; exp?: string | number } = {}) {
  return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(o.iss ?? base).setAudience(o.aud ?? "client-1").setIssuedAt().setExpirationTime(o.exp ?? "5m").sign(o.key ?? privateKey);
}

beforeAll(async () => {
  const k = await generateKeyPair("RS256"); privateKey = k.privateKey; otherKey = (await generateKeyPair("RS256")).privateKey;
  publicJwk = { ...(await exportJWK(k.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, base);
    const json = (o: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (url.pathname === "/.well-known/openid-configuration") return json({ issuer: issuerOverride ?? base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, jwks_uri: `${base}/jwks` });
    if (url.pathname === "/jwks") return json({ keys: [publicJwk] });
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = ""; for await (const c of req) raw += c;
      const p = new URLSearchParams(raw);
      const entry = codes.get(p.get("code") ?? "");
      codes.delete(p.get("code") ?? ""); // single use
      if (!entry || p.get("client_secret") !== "s3cret" || p.get("redirect_uri") !== entry.redirect) return json({ error: "invalid_grant" }, 400);
      if (createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url") !== entry.challenge) return json({ error: "invalid_grant", error_description: "PKCE" }, 400);
      const id_token = tokenOverride ? await tokenOverride(entry.claims) : await sign({ ...entry.claims, nonce: entry.nonce });
      return json({ id_token, access_token: "x", token_type: "Bearer" });
    }
    json({ error: "not_found" }, 404);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cfg = { issuer: base, clientId: "client-1", clientSecret: "s3cret", redirectUri: "https://app.example/api/auth/callback", scopes: "openid email profile", requireVerifiedEmail: true };
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { _clearDiscoveryCache(); tokenOverride = null; issuerOverride = null; });

/** Runs the whole dance like a browser would and returns what the callback would receive. */
async function begin(claims: Record<string, unknown> = { sub: "u1", email: "Marcus.Hale@Northwind.example", email_verified: true, name: "Marcus Hale" }) {
  const d = await discover(cfg);
  const { url, tx } = createAuthRequest(cfg, d);
  const q = new URL(url).searchParams;
  const code = randomUUID();
  codes.set(code, { challenge: q.get("code_challenge")!, nonce: q.get("nonce")!, claims, redirect: q.get("redirect_uri")! });
  return { d, tx, url, q, params: new URLSearchParams({ code, state: q.get("state")! }), code };
}
const fails = async (p: Promise<unknown>, code: OidcError["code"], re?: RegExp) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(OidcError); expect((e as OidcError).code).toBe(code); if (re) expect((e as OidcError).message).toMatch(re);
};

describe("OIDC authorization request", () => {
  it("uses the code flow with PKCE (S256), state and nonce, and a fresh secret each time", async () => {
    const a = await begin(), b = await begin();
    expect(a.q.get("response_type")).toBe("code"); expect(a.q.get("code_challenge_method")).toBe("S256");
    expect(a.q.get("client_id")).toBe("client-1"); expect(a.q.get("redirect_uri")).toBe(cfg.redirectUri); expect(a.q.get("scope")).toBe("openid email profile");
    expect(a.q.get("code_challenge")).toBe(createHash("sha256").update(a.tx.verifier).digest("base64url"));
    expect(a.tx.verifier.length).toBeGreaterThanOrEqual(43);
    expect(new Set([a.tx.state, b.tx.state, a.tx.nonce, b.tx.nonce, a.tx.verifier, b.tx.verifier]).size).toBe(6);
  });
});

describe("OIDC login completion", () => {
  it("accepts a correct sign-in and normalises the email", async () => {
    const s = await begin();
    expect(await completeLogin(cfg, s.d, s.params, s.tx)).toEqual({ sub: "u1", email: "marcus.hale@northwind.example", name: "Marcus Hale" });
  });

  it("rejects a wrong or missing state (CSRF), and a replayed code", async () => {
    const s = await begin();
    await fails(completeLogin(cfg, s.d, new URLSearchParams({ code: s.code, state: "forged" }), s.tx), "state");
    await fails(completeLogin(cfg, s.d, new URLSearchParams({ code: s.code }), s.tx), "state");
    await fails(completeLogin(cfg, s.d, new URLSearchParams({ state: s.tx.state }), s.tx), "state");
    const ok = await begin(); await completeLogin(cfg, ok.d, ok.params, ok.tx);
    await fails(completeLogin(cfg, ok.d, ok.params, ok.tx), "token"); // the code is single-use
  });

  it("is bound to the browser's PKCE verifier: a stolen code is useless without it", async () => {
    const s = await begin();
    await fails(completeLogin(cfg, s.d, s.params, { ...s.tx, verifier: "attacker-chosen-verifier-attacker-chosen-verifier-123" }), "token");
  });

  it("rejects tokens with a bad signature, wrong issuer, wrong audience, expiry, or a nonce from another sign-in", async () => {
    const claims = { sub: "u1", email: "a@b.test", email_verified: true };
    const cases: [string, (c: Record<string, unknown>) => Promise<string>][] = [
      ["forged signature", (c) => sign({ ...c, nonce: nonceOf }, { key: otherKey })],
      ["wrong issuer", (c) => sign({ ...c, nonce: nonceOf }, { iss: "https://evil.example" })],
      ["wrong audience", (c) => sign({ ...c, nonce: nonceOf }, { aud: "someone-else" })],
      ["expired", (c) => sign({ ...c, nonce: nonceOf }, { exp: Math.floor(Date.now() / 1000) - 3600 })],
      ["replayed nonce", (c) => sign({ ...c, nonce: "a-nonce-from-another-login" })],
      ["no nonce", (c) => sign({ ...c })],
    ];
    let nonceOf = "";
    for (const [name, make] of cases) {
      const s = await begin(claims); nonceOf = s.tx.nonce; tokenOverride = make;
      await fails(completeLogin(cfg, s.d, s.params, s.tx), "token"); // eslint-disable-line no-await-in-loop
      expect(name).toBeTruthy();
    }
  });

  it("rejects tokens signed with a weak or 'none' algorithm", async () => {
    const s = await begin(); const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ iss: base, aud: "client-1", sub: "u", email: "a@b.test", email_verified: true, nonce: s.tx.nonce })).toString("base64url")}.`;
    tokenOverride = async () => none;
    await fails(completeLogin(cfg, s.d, s.params, s.tx), "token");
  });

  it("requires a verified email by default (and honours the opt-out), and refuses tokens with no email", async () => {
    let s = await begin({ sub: "u1", email: "a@b.test", email_verified: false });
    await fails(completeLogin(cfg, s.d, s.params, s.tx), "email", /not verified/);
    s = await begin({ sub: "u1", email: "a@b.test" });
    await fails(completeLogin(cfg, s.d, s.params, s.tx), "email");
    s = await begin({ sub: "u1", email: "a@b.test" });
    expect((await completeLogin({ ...cfg, requireVerifiedEmail: false }, s.d, s.params, s.tx)).email).toBe("a@b.test");
    s = await begin({ sub: "u1", email_verified: true });
    await fails(completeLogin(cfg, s.d, s.params, s.tx), "email", /did not share/);
  });

  it("surfaces provider-side errors and wrong client credentials as safe messages", async () => {
    const s = await begin();
    await fails(completeLogin(cfg, s.d, new URLSearchParams({ error: "access_denied", state: s.tx.state }), s.tx), "provider");
    const t = await begin();
    await fails(completeLogin({ ...cfg, clientSecret: "wrong" }, t.d, t.params, t.tx), "token");
  });
});

describe("OIDC discovery and configuration", () => {
  it("refuses a provider whose advertised issuer differs from the configured one", async () => {
    issuerOverride = "https://evil.example";
    await fails(discover(cfg), "provider", /issuer does not match/);
  });
  it("refuses plain-http endpoints except on localhost, and unreachable providers", async () => {
    await fails(discover({ ...cfg, issuer: "http://idp.example.com" }), "provider", /HTTPS/);
    await fails(discover({ ...cfg, issuer: "http://127.0.0.1:1" }), "provider", /Could not reach/);
  });
  it("is read from the environment only when AUTH_MODE=oidc, and fails loudly when incomplete", () => {
    expect(oidcConfigFromEnv({ AUTH_MODE: "dev" })).toBeNull();
    expect(() => oidcConfigFromEnv({ AUTH_MODE: "oidc", OIDC_ISSUER: "https://x" })).toThrow(/requires OIDC_ISSUER/);
    expect(oidcConfigFromEnv({ AUTH_MODE: "oidc", OIDC_ISSUER: "https://idp/", OIDC_CLIENT_ID: "c", OIDC_REDIRECT_URI: "https://app/cb" })).toMatchObject({ issuer: "https://idp", scopes: "openid email profile", requireVerifiedEmail: true });
  });
});
