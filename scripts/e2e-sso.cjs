/* SSO end-to-end: boots the app in OIDC mode against the local mock identity provider and exercises the real flow, including
 * hostile callbacks. Self-contained (starts and stops its own server and IdP). Requires a seeded database and Playwright.
 * Usage: node scripts/e2e-sso.cjs */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const path = require("node:path");

const APP_PORT = 3100, IDP_PORT = 4011;
const BASE = `http://localhost:${APP_PORT}`, IDP = `http://127.0.0.1:${IDP_PORT}`;
const ROOT = path.join(__dirname, "..");
const procs = [];
const step = (m) => console.log("  ✓", m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const start = (cmd, args, opts) => { const p = spawn(cmd, args, { stdio: "ignore", detached: true, ...opts }); procs.push(p); return p; };
const stopAll = () => procs.forEach((p) => { try { process.kill(-p.pid, "SIGKILL"); } catch {} });
async function waitFor(url, ms = 60000) { const t = Date.now(); while (Date.now() - t < ms) { try { const r = await fetch(url); if (r.status < 500) return; } catch {} await sleep(500); } throw new Error(`${url} did not come up`); }
const startIdp = (verified = true) => start("node", [path.join(__dirname, "mock-idp.mjs")], { env: { ...process.env, MOCK_IDP_PORT: String(IDP_PORT), MOCK_IDP_EMAILS: "marcus.hale@northwind.example,nobody@nowhere.example", MOCK_IDP_EMAIL_VERIFIED: String(verified), OIDC_CLIENT_ID: "taxops", OIDC_CLIENT_SECRET: "dev-secret" } });

(async () => {
  let idp = startIdp();
  start("pnpm", ["exec", "next", "dev", "-p", String(APP_PORT)], { cwd: path.join(ROOT, "apps/web"), env: {
    ...process.env, AUTH_MODE: "oidc", OIDC_ISSUER: IDP, OIDC_CLIENT_ID: "taxops", OIDC_CLIENT_SECRET: "dev-secret", OIDC_REDIRECT_URI: `${BASE}/api/auth/callback`,
  } });
  await waitFor(`${IDP}/.well-known/openid-configuration`); await waitFor(`${BASE}/login`);

  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(15000);

  await page.goto(`${BASE}/login`);
  await page.getByRole("link", { name: "Continue with single sign-on" }).waitFor();
  assert.equal(await page.getByText("Development environment").count(), 0);
  assert.equal(await page.getByRole("button", { name: /Marcus Hale/ }).count(), 0); // no dev persona picker in SSO mode
  step("SSO mode shows the SSO button and no development persona picker");

  await page.getByRole("link", { name: "Continue with single sign-on" }).click();
  await page.waitForURL(/127\.0\.0\.1:4011\/authorize/);
  const authUrl = new URL(page.url());
  assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authUrl.searchParams.get("state") && authUrl.searchParams.get("nonce"));
  await page.getByRole("link", { name: "marcus.hale@northwind.example" }).click();
  await page.waitForURL(`${BASE}/`);
  await page.getByText("Welcome back, Marcus").waitFor();
  step("authorization-code flow with PKCE, state and nonce signs in an existing user");

  await page.goto(`${BASE}/audit?cat=auth.`);
  await page.getByText(/Marcus Hale signed in \(single sign-on\)/).first().waitFor();
  step("the sign-in is recorded in the audit history");

  await page.click('button[aria-label="Sign out"]'); await page.waitForURL("**/login");
  await page.getByRole("link", { name: "Continue with single sign-on" }).click();
  await page.waitForURL(/authorize/);
  await page.getByRole("link", { name: "nobody@nowhere.example" }).click();
  await page.waitForURL(/\/login\?error=no-account/);
  await page.getByText(/don’t have an account here yet/).waitFor();
  assert.equal(await page.getByText("Welcome back").count(), 0);
  step("a verified identity with no account is refused (accounts are never created implicitly)");

  // Hostile callbacks: no transaction cookie, forged state, replay
  const bare = await page.context().request.get(`${BASE}/api/auth/callback?code=stolen&state=forged`, { maxRedirects: 0 });
  assert.equal(bare.status(), 302); assert.match(bare.headers().location, /\/login\?error=sso/);
  const err = await page.context().request.get(`${BASE}/api/auth/callback?error=access_denied`, { maxRedirects: 0 });
  assert.match(err.headers().location, /error=sso/);
  assert.equal((await page.goto(`${BASE}/`)).url().includes("/login"), true); // still signed out after all of that
  step("forged or missing sign-in state is refused and leaves you signed out");

  // Unverified email at the IdP
  process.kill(-idp.pid, "SIGKILL"); await sleep(500); idp = startIdp(false); await waitFor(`${IDP}/.well-known/openid-configuration`);
  await page.goto(`${BASE}/login`);
  await page.getByRole("link", { name: "Continue with single sign-on" }).click();
  await page.waitForURL(/authorize/); await page.getByRole("link", { name: "marcus.hale@northwind.example" }).click();
  await page.waitForURL(/\/login\?error=email/);
  await page.getByText(/didn’t confirm a verified email/).waitFor();
  step("an identity provider that does not vouch for the email is refused");

  // Rate limiting on the auth endpoints
  let limited = 0;
  for (let i = 0; i < 30; i++) { const r = await page.context().request.get(`${BASE}/api/auth/login`, { maxRedirects: 0 }); if (r.status() === 429) { limited++; assert.ok(r.headers()["retry-after"]); } }
  assert.ok(limited > 0, "the login endpoint should rate-limit bursts");
  step("bursts against the sign-in endpoint are rate-limited (429 with Retry-After)");

  await browser.close();
  stopAll();
  console.log("SSO e2e passed.");
})().catch((e) => { console.error("SSO E2E FAILED:", e.message); stopAll(); process.exit(1); });
