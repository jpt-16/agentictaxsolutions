#!/usr/bin/env node
/**
 * A tiny OpenID Connect identity provider for LOCAL development and the SSO end-to-end test. NOT for production use:
 * it "authenticates" anyone by letting you click an email. It does enforce the real protocol checks (PKCE, single-use codes,
 * redirect URI, client secret) and signs ID tokens with a fresh RS256 key each start.
 *
 *   MOCK_IDP_PORT=4010 MOCK_IDP_EMAILS=marcus.hale@northwind.example,tomas.berg@northwind.example node scripts/mock-idp.mjs
 *   then run the app with AUTH_MODE=oidc OIDC_ISSUER=http://127.0.0.1:4010 OIDC_CLIENT_ID=taxops OIDC_CLIENT_SECRET=dev-secret
 *        OIDC_REDIRECT_URI=http://localhost:3000/api/auth/callback
 */
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
// `jose` is a dependency of the web app; resolve it from there so this script needs no extra install.
const webPkg = path.join(path.dirname(fileURLToPath(import.meta.url)), "../apps/web/package.json");
const { SignJWT, exportJWK, generateKeyPair } = await import(pathToFileURL(createRequire(webPkg).resolve("jose")).href);

const port = Number(process.env.MOCK_IDP_PORT ?? 4010);
const base = `http://127.0.0.1:${port}`;
const clientId = process.env.OIDC_CLIENT_ID ?? "taxops", clientSecret = process.env.OIDC_CLIENT_SECRET ?? "dev-secret";
const emails = (process.env.MOCK_IDP_EMAILS ?? "marcus.hale@northwind.example").split(",").map((e) => e.trim()).filter(Boolean);
const verified = process.env.MOCK_IDP_EMAIL_VERIFIED !== "false";
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "mock-1", alg: "RS256", use: "sig" };
const codes = new Map();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

http.createServer(async (req, res) => {
  const url = new URL(req.url, base);
  const json = (o, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (url.pathname === "/.well-known/openid-configuration") return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, jwks_uri: `${base}/jwks` });
  if (url.pathname === "/jwks") return json({ keys: [jwk] });
  if (url.pathname === "/authorize") {
    const q = url.searchParams;
    if (q.get("client_id") !== clientId || q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) { res.writeHead(400); return res.end("bad request"); }
    const pick = url.searchParams.get("pick");
    if (pick) {
      const code = randomUUID();
      codes.set(code, { email: pick, nonce: q.get("nonce"), challenge: q.get("code_challenge"), redirect: q.get("redirect_uri") });
      const back = new URL(q.get("redirect_uri")); back.searchParams.set("code", code); back.searchParams.set("state", q.get("state"));
      res.writeHead(302, { location: back.toString() }); return res.end();
    }
    const items = emails.map((e) => { const u = new URL(url); u.searchParams.set("pick", e); return `<li><a href="${esc(u.pathname + u.search)}">${esc(e)}</a></li>`; }).join("");
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<!doctype html><title>Mock identity provider</title><h1>Mock identity provider</h1><p>Development only. Choose who you are:</p><ul>${items}</ul>`);
  }
  if (url.pathname === "/token" && req.method === "POST") {
    let raw = ""; for await (const c of req) raw += c;
    const p = new URLSearchParams(raw), e = codes.get(p.get("code") ?? "");
    codes.delete(p.get("code") ?? "");
    if (!e || p.get("client_secret") !== clientSecret || p.get("redirect_uri") !== e.redirect || createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url") !== e.challenge) return json({ error: "invalid_grant" }, 400);
    const id_token = await new SignJWT({ sub: `mock|${e.email}`, email: e.email, email_verified: verified, name: e.email.split("@")[0], nonce: e.nonce })
      .setProtectedHeader({ alg: "RS256", kid: "mock-1" }).setIssuer(base).setAudience(clientId).setIssuedAt().setExpirationTime("5m").sign(privateKey);
    return json({ id_token, access_token: "mock", token_type: "Bearer" });
  }
  json({ error: "not_found" }, 404);
}).listen(port, "127.0.0.1", () => console.log(`Mock IdP listening on ${base} (users: ${emails.join(", ")})`));
