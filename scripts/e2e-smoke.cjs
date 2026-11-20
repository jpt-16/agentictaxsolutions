/* End-to-end smoke test through the real UI. Requires: dev server on :3000, a freshly seeded DB
 * (`pnpm db:reset`), and Playwright with Chromium available (`require('playwright')`).
 * Usage: node scripts/e2e-smoke.cjs */
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  page.setDefaultTimeout(8000);
  page.on("dialog", (d) => d.accept());
  const step = (m) => console.log("  ✓", m);

  const login = async (name) => {
    await page.goto(`${BASE}/login`);
    await page.click(`button:has-text("${name}")`);
    await page.waitForURL(`${BASE}/`);
  };
  const logout = async () => { await page.click('button[aria-label="Sign out"]'); await page.waitForURL("**/login"); };

  // 1. Manager creates and publishes a request
  await login("Marcus Hale");
  await page.goto(`${BASE}/requests/new`);
  await page.click('button:has-text("Publish request")');
  await page.waitForSelector("text=Title must be at least 5 characters");
  step("form validation shows field errors, nothing saved");

  await page.fill("#title", "E2E smoke – FY2025 depreciation schedules");
  await page.fill("#due", "2027-02-15");
  await page.fill('[aria-label="Item 1 title"]', "Depreciation schedule – US assets");
  await page.click('button:has-text("Add item")');
  await page.fill('[aria-label="Item 2 title"]', "Disposals during the year");
  await page.click('label:has-text("Accounting – Americas") input');
  await page.click('button:has-text("Publish request")');
  await page.waitForURL(/\/requests\/[0-9a-f-]{36}/);
  const requestUrl = page.url();
  await page.waitForSelector("text=Depreciation schedule – US assets");
  assert.match(await page.locator("body").innerText(), /Open/);
  step("manager created and published a request with two items");
  await logout();

  // 2. A contributor outside the assignment cannot see it; one inside can submit
  await login("Hiro Tanaka"); // APAC / Japan: not assigned
  const outside = await page.goto(requestUrl);
  assert.equal(outside.status(), 404);
  step("unassigned contributor gets 404 (no existence leak)");
  await logout();

  const ITEM1 = "Depreciation schedule – US assets";
  const ITEM2 = "Disposals during the year";
  const item = (title) => page.locator('li[id^="item-"]', { hasText: title });
  const btn = (title, name) => item(title).getByRole("button", { name, exact: true });

  await login("Sam Whitfield"); // Accounting – Americas: assigned
  await page.goto(requestUrl);
  await item(ITEM1).locator("textarea").fill("US depreciation schedule attached, tied to GL.");
  await btn(ITEM1, "Submit").click();
  await item(ITEM1).getByText("US depreciation schedule attached").waitFor();
  step("assigned contributor submitted an item");
  await logout();

  // 3. Reviewer requests changes, contributor resubmits, reviewer approves both
  await login("Naomi Clarke");
  await page.goto(requestUrl);
  await item(ITEM1).locator("textarea").fill("Please split additions by quarter.");
  await btn(ITEM1, "Request changes").click();
  await item(ITEM1).getByText("Please split additions by quarter.").waitFor();
  step("reviewer requested changes with a rationale");
  await logout();

  await login("Sam Whitfield");
  await page.goto(requestUrl);
  await item(ITEM1).locator("textarea").fill("Split by quarter in tab 2.");
  await btn(ITEM1, "Resubmit").click();
  await item(ITEM1).getByText("Split by quarter in tab 2.").waitFor();
  await item(ITEM2).locator("textarea").fill("No disposals this year; confirmed with fixed assets.");
  await btn(ITEM2, "Submit").click();
  await item(ITEM2).getByText("No disposals this year").waitFor();
  step("contributor resubmitted item 1 (v2) and submitted item 2");
  await logout();

  await login("Naomi Clarke");
  await page.goto(requestUrl);
  for (const t of [ITEM1, ITEM2]) {
    await btn(t, "Approve").click();
    await item(t).getByText("Approved", { exact: true }).first().waitFor();
  }
  await page.reload();
  assert.match(await page.locator("body").innerText(), /2 of 2 approved/);
  step("reviewer approved both items; request auto-advanced to Approved");
  await logout();

  // 4. Manager closes it
  await login("Marcus Hale");
  await page.goto(requestUrl);
  await page.click('button:has-text("Sign off & close")');
  await page.waitForSelector('span.badge:has-text("Closed")');
  step("manager signed off and closed the request");
  await logout();

  // 5. Auditor sees everything, chain verifies
  await login("Grace Okafor");
  await page.goto(`${BASE}/audit?verify=1`);
  await page.waitForSelector("text=Chain intact");
  const audit = await page.locator("body").innerText();
  for (const a of ["request.created", "request.published", "item.submitted", "item.changes_requested", "item.approved", "request.closed"]) {
    assert.ok(audit.includes(a), `audit log should include ${a}`);
  }
  step("auditor sees the full trail and the hash chain verifies");

  await browser.close();
  console.log("E2E smoke test passed.");
})().catch((e) => { console.error("E2E FAILED:", e.message); process.exit(1); });
