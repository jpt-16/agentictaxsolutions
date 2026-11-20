/* End-to-end smoke test through the real UI. Requires: dev server on :3000, a freshly seeded DB
 * (`pnpm db:reset`), and Playwright with Chromium available (`require('playwright')`).
 * Usage: node scripts/e2e-smoke.cjs */
const { chromium } = require("playwright");
const path = require("node:path");
const { execSync } = require("node:child_process");
// exceljs lives in the services package; resolve it from there so this script needs no extra install.
const ExcelJS = require(require.resolve("exceljs", { paths: [path.join(__dirname, "../packages/services")] }));
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

  const workbook = async (cell) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Depreciation");
    ws.addRow(["Asset class", "Opening cost", "Closing cost"]);
    ws.addRow(["Machinery", 1250000, cell]);
    return Buffer.from(await wb.xlsx.writeBuffer());
  };
  const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  await login("Sam Whitfield"); // Accounting – Americas: assigned
  await page.goto(requestUrl);

  // A virus is blocked in the UI: nothing is submitted
  await item(ITEM1).locator("textarea").fill("Attaching the schedule.");
  await item(ITEM1).locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*") });
  await item(ITEM1).getByText("notes.txt").waitFor(); // the attachment must be visibly queued before submitting
  await btn(ITEM1, "Submit").click();
  await item(ITEM1).getByText("blocked by the virus scan").waitFor();
  assert.match(await item(ITEM1).innerText(), /Pending/);
  step("EICAR test virus was blocked; item stayed pending");

  // A macro-enabled workbook is refused with guidance
  await item(ITEM1).locator('input[type="file"]').setInputFiles({ name: "book.xlsm", mimeType: XLSX_MIME, buffer: await workbook(1) });
  await btn(ITEM1, "Submit").click();
  await item(ITEM1).getByText(/Macro-enabled/).waitFor();
  step("macro-enabled workbook was refused with a helpful message");

  // A clean workbook goes through
  await item(ITEM1).locator('input[type="file"]').setInputFiles([]); // clear browser selection
  await page.reload();
  await item(ITEM1).locator("textarea").fill("US depreciation schedule attached, tied to GL.");
  await item(ITEM1).locator('input[type="file"]').setInputFiles({ name: "Depreciation_US.xlsx", mimeType: XLSX_MIME, buffer: await workbook(1180000) });
  await btn(ITEM1, "Submit").click();
  await item(ITEM1).getByText("Depreciation_US.xlsx").waitFor();
  step("assigned contributor submitted an item with a scanned workbook");

  // Viewer + authorized download
  await item(ITEM1).getByRole("link", { name: "View" }).click();
  await page.waitForSelector("text=Read-only preview");
  await page.getByRole("cell", { name: "Machinery" }).waitFor();
  await page.getByRole("cell", { name: "1180000" }).waitFor();
  step("spreadsheet viewer renders the workbook contents");
  const fileHref = await (async () => { await page.goBack(); return item(ITEM1).locator('a[href^="/api/files/"]').first().getAttribute("href"); })();
  const dl = await page.context().request.get(`${BASE}${fileHref}`);
  assert.equal(dl.status(), 200);
  assert.match(dl.headers()["content-disposition"], /^attachment; filename="Depreciation_US\.xlsx"/);
  assert.equal(dl.headers()["x-content-type-options"], "nosniff");
  assert.match(dl.headers()["content-security-policy"], /sandbox/);
  step("download is an attachment with nosniff + sandbox CSP");
  const tbWorkbook = async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Ledger TB");
    ws.addRow(["Account", "Description", "Debit", "Credit"]);
    ws.addRow(["1000", "Cash", 1000, 0]); ws.addRow(["2000", "Payables", 0, 600]); ws.addRow(["3000", "Equity", 0, 350]);
    return Buffer.from(await wb.xlsx.writeBuffer());
  };
  await item(ITEM2).locator("textarea").fill("No disposals this year; trial balance for the disposal entity attached.");
  await item(ITEM2).locator('input[type="file"]').setInputFiles({ name: "Disposal_Entity_TB.xlsx", mimeType: XLSX_MIME, buffer: await tbWorkbook() });
  await btn(ITEM2, "Submit").click();
  await item(ITEM2).getByText("Disposal_Entity_TB.xlsx").waitFor();
  await logout();

  // The AI worker processes the queue. Contributors never see AI output.
  const WORKER = process.env.WORKER_CMD ?? "python3 -m taxops_agents --once";
  execSync(WORKER, { cwd: path.join(__dirname, "../services/agent-worker"), stdio: "pipe", env: process.env });
  await login("Sam Whitfield");
  assert.equal((await page.goto(`${BASE}/review`)).status(), 404);
  await page.goto(requestUrl);
  assert.doesNotMatch(await item(ITEM2).innerText(), /AI result|AI queued/);
  step("worker processed the upload; contributors see no AI information and /review is 404");
  await logout();

  // A reviewer checks the AI result against the source, then accepts it
  await login("Naomi Clarke");
  await page.goto(`${BASE}/review`);
  await page.getByRole("link", { name: "Trial balance – Ledger TB" }).first().click();
  await page.waitForSelector("text=Column mapping");
  assert.match(await page.locator("body").innerText(), /AI-generated/);
  assert.match(await page.locator("body").innerText(), /Debits and credits differ/);
  await page.getByRole("cell", { name: "Column C" }).waitFor();
  await page.getByRole("link", { name: "Row 2" }).waitFor(); // lineage link into the file viewer
  await page.getByRole("button", { name: "Reject…" }).click();
  assert.equal(await page.getByRole("button", { name: "Enter a reason to reject" }).isDisabled(), true);
  step("review page shows mapping, totals gap and lineage; rejecting needs a reason");
  await page.getByRole("button", { name: "Accept as correctly read" }).click();
  await page.waitForSelector("text=Accepted");
  await page.goto(requestUrl);
  await item(ITEM2).getByText("AI result accepted").waitFor();
  step("reviewer accepted the AI result; the request page reflects it");
  await logout();



  // Access control on files: unassigned contributor and anonymous callers get nothing
  await login("Hiro Tanaka");
  const denied = await page.context().request.get(`${BASE}${fileHref}`);
  assert.equal(denied.status(), 404);
  step("unassigned contributor cannot download the file (404)");
  await logout();
  const anon = await (await browser.newContext()).request.get(`${BASE}${fileHref}`);
  assert.equal(anon.status(), 401);
  const csrf = await (await browser.newContext()).request.post(`${BASE}/api/submissions`, { headers: { origin: "http://evil.example" }, multipart: { itemId: "x" } });
  assert.equal(csrf.status(), 403);
  step("anonymous download is 401; cross-origin upload is refused (403)");

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
  step("contributor resubmitted item 1 (v2)");
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
  for (const a of ["request.created", "request.published", "item.submitted", "item.changes_requested", "item.approved", "request.closed", "file.rejected", "file.viewed", "file.downloaded", "proposal.created", "proposal.accepted"]) {
    assert.ok(audit.includes(a), `audit log should include ${a}`);
  }
  step("auditor sees the full trail and the hash chain verifies");

  await browser.close();
  console.log("E2E smoke test passed.");
})().catch((e) => { console.error("E2E FAILED:", e.message); process.exit(1); });
