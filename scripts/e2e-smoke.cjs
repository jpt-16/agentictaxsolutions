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
  // Consequential actions use the app's own confirmation sheet (native <dialog>), not window.confirm.
  const confirmSheet = async () => { await page.waitForSelector("dialog[open] [data-confirm]"); await page.click("dialog[open] [data-confirm]"); await page.waitForSelector("dialog[open]", { state: "detached" }); };
  const step = (m) => console.log("  ✓", m);
  /** Server actions commit asynchronously; reload-and-check until the page reflects the change. */
  const eventually = async (fn, tries = 6) => {
    for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= tries - 1) throw e; await page.waitForTimeout(500); } }
  };

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
  await page.goto(`${BASE}/notifications`);
  await page.getByText("New request: E2E smoke – FY2025 depreciation schedules").waitFor();
  await page.getByText("New request: E2E smoke – FY2025 depreciation schedules").click(); // marks it read and opens the request
  await page.waitForURL(requestUrl);
  step("assignee was notified of the new request; opening the notification marks it read and navigates");
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
  assert.equal((await page.goto(`${BASE}/settings`)).status(), 404);
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

  // The reviewer corrects the column mapping; the worker re-extracts and the corrected result replaces this one.
  await page.getByRole("button", { name: "Fix column mapping…" }).click();
  await page.getByRole("button", { name: "Re-extract with this mapping" }).click();
  await page.waitForSelector("text=Re-extraction queued");
  execSync(WORKER, { cwd: path.join(__dirname, "../services/agent-worker"), stdio: "pipe", env: process.env });
  await page.goto(`${BASE}/review`);
  await page.getByRole("link", { name: "Trial balance – Ledger TB" }).first().click();
  await page.waitForSelector("text=Reviewer-corrected mapping");
  step("reviewer corrected the column mapping; the worker re-extracted and replaced the result");

  await page.getByRole("button", { name: "Accept as correctly read" }).click();
  await page.waitForSelector("text=Accepted");
  await page.goto(requestUrl);
  await item(ITEM2).getByText("AI result accepted").waitFor();
  step("reviewer accepted the AI result; the request page reflects it");
  await logout();

  // Accepting triggered validation. The worker raises a finding the reviewer can confirm and send back.
  execSync(WORKER, { cwd: path.join(__dirname, "../services/agent-worker"), stdio: "pipe", env: process.env });
  await login("Naomi Clarke");
  await page.goto(`${BASE}/review?kind=finding`);
  await page.getByRole("link", { name: "Debits and credits differ by 50" }).first().click();
  await page.waitForSelector("text=Deterministic rule");
  assert.match(await page.locator("body").innerText(), /Suggested next step/);
  await page.getByRole("button", { name: "Confirm this is an issue" }).click();
  await page.waitForSelector("text=Confirmed");
  await page.getByRole("button", { name: "Send back to contributor" }).click();
  await confirmSheet();
  await page.waitForSelector('button:has-text("Send back to contributor")', { state: "detached" });
  await eventually(async () => {
    await page.goto(requestUrl);
    await item(ITEM2).getByText("Changes requested", { exact: true }).first().waitFor({ timeout: 1500 });
    await item(ITEM2).getByText(/Validation finding: Debits and credits differ by 50/).waitFor({ timeout: 1500 });
  });
  step("validation raised a finding; reviewer confirmed it and sent the item back with the finding as the reason");
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
  await item(ITEM2).locator("textarea").fill("Corrected the disposal entity trial balance; now balanced.");
  await btn(ITEM2, "Resubmit").click();
  await item(ITEM2).getByText("Corrected the disposal entity trial balance").waitFor();
  step("contributor resubmitted item 1 (v2) and the item sent back by validation");
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
  await confirmSheet();
  await page.waitForSelector('span.badge:has-text("Closed")');
  step("manager signed off and closed the request");
  assert.equal((await page.goto(`${BASE}/settings`)).status(), 200);
  await page.getByLabel("Enable One side per account").uncheck();
  await page.locator("li", { hasText: "One side per account" }).getByRole("button", { name: "Save" }).click();
  await page.waitForSelector("text=Saved. Applies the next time validation runs.");
  step("manager switched a validation rule off from Settings");
  await logout();

  // 5. Auditor sees everything, chain verifies
  await login("Grace Okafor");
  await page.goto(`${BASE}/audit?verify=1`);
  await page.waitForSelector("text=Chain intact");
  let audit = await page.locator("body").innerText();
  for (let n = 2; n <= 8; n++) { // the log is paginated (30 per page); read it all
    await page.goto(`${BASE}/audit?page=${n}`);
    const more = await page.locator("body").innerText();
    if (!/\bseq\b|Audit history/.test(more) || more.includes("No events found")) break;
    audit += "\n" + more;
  }
  for (const a of ["request.created", "request.published", "item.submitted", "item.changes_requested", "item.approved", "request.closed", "file.rejected", "file.viewed", "file.downloaded", "proposal.created", "proposal.accepted", "proposal.remap_requested", "rule.updated"]) {
    assert.ok(audit.includes(a), `audit log should include ${a}`);
  }
  step("auditor sees the full trail and the hash chain verifies");

  // Audit export: download, then verify offline with nothing but SHA-256.
  await page.goto(`${BASE}/audit`);
  const [csvDl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "CSV" }).click()]);
  assert.match(csvDl.suggestedFilename(), /^audit-.*\.csv$/);
  const csvPath = path.join(require("node:os").tmpdir(), `e2e-${Date.now()}.csv`);
  await csvDl.saveAs(csvPath);
  assert.match(require("node:fs").readFileSync(csvPath, "utf8").split("\r\n")[0], /^seq,occurred_at,actor_type,actor_label,action/);
  const [jsonDl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "JSON" }).click()]);
  const jsonPath = path.join(require("node:os").tmpdir(), `e2e-${Date.now()}.json`);
  await jsonDl.saveAs(jsonPath);
  const out = execSync(`node ${path.join(__dirname, "verify-audit-export.mjs")} ${jsonPath}`, { encoding: "utf8" });
  assert.match(out, /OK: \d+ event\(s\) verified, contiguous from the genesis hash/);
  step("auditor exported the audit log; the offline verifier confirmed the whole chain from the file alone");
  await logout();

  // Draft editing, and publishing makes it read-only
  await login("Marcus Hale");
  await page.goto(`${BASE}/requests/new`);
  await page.fill("#title", "E2E editable draft request");
  await page.fill("#due", "2027-04-01");
  await page.fill('[aria-label="Item 1 title"]', "First draft item");
  await page.click('label:has-text("Accounting – Americas") input');
  await page.click('button:has-text("Save draft")');
  await page.waitForURL(/\/requests\/[0-9a-f-]{36}$/);
  const draftUrl = page.url();
  await page.getByRole("link", { name: "Edit draft" }).click();
  await page.fill("#title", "E2E edited draft request");
  await page.fill('[aria-label="Item 1 title"]', "Renamed draft item");
  await page.click('button:has-text("Save changes")');
  await page.waitForURL(draftUrl);
  await page.getByText("E2E edited draft request").first().waitFor();
  await page.getByText("Renamed draft item").waitFor();
  await page.click('button:has-text("Publish request")');
  await confirmSheet();
  await page.waitForSelector('span.badge:has-text("Open")');
  assert.equal(await page.getByRole("link", { name: "Edit draft" }).count(), 0);
  await page.goto(`${draftUrl}/edit`);
  await page.waitForURL(draftUrl); // a published request redirects away from the editor
  step("manager edited a draft; once published it is read-only and the editor redirects");
  await logout();

  // Deadline sweep notifies the people who owe overdue work, once
  execSync("pnpm notify:sweep", { cwd: path.join(__dirname, ".."), stdio: "pipe", env: process.env });
  await login("Lena Fischer");
  await page.goto(`${BASE}/notifications`);
  await page.getByText(/^Overdue: Q4 intercompany balance confirmations/).first().waitFor();
  step("deadline sweep sent an overdue reminder to an assignee of the overdue request");
  await logout();

  // ===== Documents, templates, @mentions, reports, and server-side sign-out =====
  const SAMPLES = path.join(__dirname, "../samples");
  const fs = require("node:fs");
  const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  await login("Marcus Hale");
  await page.goto(`${BASE}/requests/new`);
  await page.fill("#title", "E2E documents – intercompany confirmations");
  await page.fill("#due", "2027-03-01");
  await page.fill('[aria-label="Item 1 title"]', "Signed balance confirmation");
  await page.click('label:has-text("Accounting – Americas") input');
  await page.click('button:has-text("Publish request")');
  await page.waitForURL(/\/requests\/[0-9a-f-]{36}/);
  const docUrl = page.url();
  await page.locator("#comment").fill("Please attach the signed confirmation, @Sam Whitfield. Thank you.");
  await page.getByRole("button", { name: "Post comment" }).click();
  await page.getByText("Please attach the signed confirmation").waitFor();
  await page.locator("p span", { hasText: "@Sam Whitfield" }).first().waitFor(); // the mention is highlighted

  await page.getByRole("button", { name: "Save as template" }).click();
  await page.fill("#tpl-name", "E2E confirmation pack");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForSelector(".toast:has-text('Template saved')");
  await page.goto(`${BASE}/requests/new`);
  await page.getByRole("link", { name: /E2E confirmation pack/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("input")].some((i) => i.value === "Signed balance confirmation"));
  step("manager saved a request as a template and started a new request from it; the @mention was highlighted");
  await logout();

  await login("Sam Whitfield");
  await page.goto(`${BASE}/notifications`);
  await page.getByText(/Marcus Hale mentioned you on TX-/).first().waitFor();
  await page.goto(docUrl);
  const DOCITEM = "Signed balance confirmation";
  await item(DOCITEM).locator("textarea").fill("Signed confirmations attached.");
  await item(DOCITEM).locator('input[type="file"]').setInputFiles([
    { name: "balance-confirmation.docx", mimeType: DOCX_MIME, buffer: fs.readFileSync(path.join(SAMPLES, "balance-confirmation.docx")) },
    { name: "balance-confirmation.pdf", mimeType: "application/pdf", buffer: fs.readFileSync(path.join(SAMPLES, "balance-confirmation.pdf")) },
  ]);
  await btn(DOCITEM, "Submit").click();
  await item(DOCITEM).getByText("balance-confirmation.pdf").waitFor();
  step("the mentioned contributor was notified, then uploaded a Word and a PDF document");
  await logout();

  execSync(WORKER, { cwd: path.join(__dirname, "../services/agent-worker"), stdio: "pipe", env: process.env });
  await login("Naomi Clarke");
  await page.goto(`${BASE}/review`);
  await page.getByRole("link", { name: "Supporting document: balance-confirmation.pdf" }).first().click();
  await page.waitForSelector("text=What the agent read");
  const docText = await page.locator("body").innerText();
  assert.match(docText, /Balance confirmation/);
  assert.match(docText, /EUR 340,000\.00/);
  assert.match(docText, /15 January 2026/);
  await page.getByRole("button", { name: "Accept as correctly read" }).click();
  await page.getByText("Accepted", { exact: true }).first().waitFor();
  step("document agent read the PDF; the reviewer saw the extracted facts and accepted them");
  await logout();

  await login("Marcus Hale");
  await page.goto(`${BASE}/reports`);
  await page.getByRole("heading", { name: "Reports" }).waitFor();
  assert.match(await page.locator("body").innerText(), /Average time to close/);
  const post = (url, form) => page.context().request.post(`${BASE}${url}`, { headers: { origin: BASE }, form });
  const csv = await post("/api/reports/status", {});
  assert.equal(csv.status(), 200);
  assert.match(csv.headers()["content-type"], /text\/csv/);
  assert.match((await csv.text()).split("\r\n")[0], /^reference,title,tax_year,status/);
  const mainId = requestUrl.split("/").pop();
  const pack = await post("/api/reports/data", { requestId: mainId });
  assert.equal(pack.status(), 200);
  const packText = await pack.text();
  assert.match(packText.split("\r\n")[0], /^request,item,file,sheet,currency,source_row,account_code/);
  assert.match(packText, /,1000,Cash,/); // the accepted trial balance, line by line
  assert.equal((await page.context().request.post(`${BASE}/api/reports/status`, { form: {} })).status(), 403); // no Origin header: refused
  step("reports page, status CSV and approved-data pack work; cross-origin export is refused");

  // Sign-out voids the token on the server, not just in the browser
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === "taxops_session");
  assert.ok(session);
  await logout();
  await page.context().addCookies([session]);
  await page.goto(`${BASE}/requests`);
  await page.waitForURL("**/login");
  step("a copied session cookie stops working after sign-out (server-side revocation)");
  await login("Sam Whitfield");
  assert.equal((await page.goto(`${BASE}/reports`)).status(), 404); // contributors have no reports
  await logout();

  // ===== Reconciliation: a signed confirmation letter checked against the trial balance in the same request =====
  await login("Marcus Hale");
  await page.goto(`${BASE}/requests/new`);
  await page.fill("#title", "E2E reconciliation – Germany and France");
  await page.fill("#due", "2027-03-15");
  await page.fill('[aria-label="Item 1 title"]', "Trial balance, Germany");
  await page.click('button:has-text("Add item")');
  await page.fill('[aria-label="Item 2 title"]', "France confirmation letter");
  await page.click('label:has-text("Accounting – Americas") input');
  await page.click('button:has-text("Publish request")');
  await page.waitForURL(/\/requests\/[0-9a-f-]{36}/);
  const recUrl = page.url();
  await logout();
  await login("Sam Whitfield");
  await page.goto(recUrl);
  const TBITEM = "Trial balance, Germany", LETTERITEM = "France confirmation letter";
  await item(TBITEM).locator("textarea").fill("German trial balance attached.");
  await item(TBITEM).locator('input[type="file"]').setInputFiles({ name: "germany-tb.xlsx", mimeType: XLSX_MIME, buffer: fs.readFileSync(path.join(SAMPLES, "messy-trial-balance-germany.xlsx")) });
  await btn(TBITEM, "Submit").click();
  await item(TBITEM).getByText("germany-tb.xlsx").waitFor();
  await item(LETTERITEM).locator("textarea").fill("Signed confirmation letter attached.");
  await item(LETTERITEM).locator('input[type="file"]').setInputFiles({ name: "france-confirmation.docx", mimeType: DOCX_MIME, buffer: fs.readFileSync(path.join(SAMPLES, "balance-confirmation.docx")) });
  await btn(LETTERITEM, "Submit").click();
  await item(LETTERITEM).getByText("france-confirmation.docx").waitFor();
  await logout();

  execSync(WORKER, { cwd: path.join(__dirname, "../services/agent-worker"), stdio: "pipe", env: process.env });
  await login("Naomi Clarke");
  const acceptResult = async (file) => {
    await page.goto(`${BASE}/review`);
    await page.locator("tr", { hasText: file }).getByRole("link").first().click();
    await page.getByRole("button", { name: "Accept as correctly read" }).click();
    await page.getByText("Accepted", { exact: true }).first().waitFor();
  };
  await page.goto(`${BASE}/review`);
  await page.locator("tr", { hasText: "germany-tb.xlsx" }).getByRole("link").first().click();
  await page.waitForSelector("text=Column mapping");
  assert.match(await page.locator("body").innerText(), /EUR · from sheet title/); // every result states its currency and where that came from
  await page.getByRole("button", { name: "Accept as correctly read" }).click();
  await page.getByText("Accepted", { exact: true }).first().waitFor();
  execSync(WORKER, { cwd: path.join(__dirname, "../services/agent-worker"), stdio: "pipe", env: process.env }); // validation runs; reconciliation has no letter yet
  await acceptResult("france-confirmation.docx");
  execSync(WORKER, { cwd: path.join(__dirname, "../services/agent-worker"), stdio: "pipe", env: process.env }); // reconciliation compares the letter with the books
  await page.goto(`${BASE}/review?kind=finding`);
  const direction = page.locator("tr", { hasText: "is a payable on both sides" });
  await direction.waitFor();
  await page.locator("tr", { hasText: "germany-tb.xlsx" }).filter({ hasText: "Debits and credits differ" }).waitFor(); // the Checker's finding was not retired by the second agent
  await direction.getByRole("link").first().click();
  await page.waitForSelector("text=Suggested next step");
  const f = await page.locator("body").innerText();
  assert.match(f, /EUR 340,000\.00/);
  assert.match(f, /Northwind France SAS/);
  assert.match(f, /cannot tell which entity a trial balance belongs to/); // it states what it does not know
  step("a letter and a trial balance in one request were reconciled by a second agent; the first agent's finding survived; currency is shown");
  await logout();

  // Administration: AI governance switches and people management (tenant admin only)
  await login("Priya Raman");
  await page.goto(`${BASE}/settings`);
  await page.getByLabel("Allow an external AI model").check();
  await page.getByRole("button", { name: "Save" }).first().click();
  await confirmSheet(); // sending excerpts to an external provider asks first
  await page.waitForSelector("text=Settings saved");
  await page.locator('button:has-text("Saving")').waitFor({ state: "detached" }); // the toast shows slightly before the transition settles
  await page.getByLabel("AI extraction").uncheck(); // turning AI off also turns external use off
  await page.getByRole("button", { name: "Save" }).first().click();
  await page.waitForSelector(".toast:has-text('Settings saved')");
  await page.locator('button:has-text("Saving")').waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Add a person" }).click();
  await page.fill("#nu-name", "E2E New Person");
  await page.fill("#nu-email", "e2e.person@northwind.example");
  await page.getByRole("button", { name: "Add person" }).click();
  await page.getByText("e2e.person@northwind.example").waitFor();
  await page.getByLabel("Role for Priya Raman").waitFor();
  assert.equal(await page.getByLabel("Role for Priya Raman").isDisabled(), true); // cannot change your own role
  step("tenant admin changed AI governance switches and added a person; self-demotion is blocked");
  await page.goto(`${BASE}/audit?cat=user.`);
  await page.getByText(/Added E2E New Person as Contributor/).waitFor(); // administration is itself audited
  await logout();

  // Operations endpoints
  const health = await (await fetch(`${BASE}/api/health`)).json();
  assert.deepEqual(health, { status: "ok" });
  const ready = await (await fetch(`${BASE}/api/ready`)).json();
  assert.equal(ready.status, "ready");
  assert.equal((await fetch(`${BASE}/api/metrics`)).status, 404); // disabled until METRICS_TOKEN is set
  assert.ok((await fetch(`${BASE}/login`)).headers.get("x-request-id"));
  step("health, readiness and request-id work; metrics are off without a token");

  await browser.close();
  console.log("E2E smoke test passed.");
})().catch((e) => { console.error("E2E FAILED:", e.message); process.exit(1); });
