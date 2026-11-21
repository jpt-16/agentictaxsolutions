# Architecture

## Principles

1. **AI proposes, humans dispose.** Agents never write canonical data; they emit *proposals* that a tax professional accepts or rejects.
2. **Code calculates, the model interprets.** Totals, cross-footing and rule checks are deterministic. The LLM maps messy columns and explains findings.
3. **Isolation in the database, not only in code.** A bug in application code must not be able to leak another tenant's data.
4. **Modular monolith first.** Clear seams, one deployable. Split only with a reason.
5. **Agents are plugins** behind one contract, so adding an agent never changes the core.

## Stack and decisions

| Concern | Choice | Notes |
|---|---|---|
| Web | Next.js 16 (App Router), React 19, Tailwind 4 | Server components + server actions; UI contains no business rules |
| Domain/services | TypeScript | `core` is pure; `services` owns authorization, scoping, transitions, audit |
| Database | PostgreSQL 16, Drizzle ORM, SQL migrations | RLS + composite tenant FKs |
| AI runtime | **Python** worker (`services/agent-worker`) | Chosen for the ML/data ecosystem. Isolated behind a contract |
| LLM | **Gemini** via a provider-agnostic gateway | Cost-driven choice. Swappable; redaction + schema-validated output live in the gateway |
| Queue | Postgres `jobs` table, `FOR UPDATE SKIP LOCKED` (built in Phase 2) | **Changed from the original proposal (pg-boss).** pg-boss is Node-only; a plain SQL queue is language-neutral so the Python worker can consume it with no extra infrastructure |
| Auth | Dev persona picker (stub); OIDC/SAML SSO planned | Downstream code only needs the session cookie and `loadSession()` |

### How the TypeScript app and Python worker meet
Both talk to the same Postgres. The web app enqueues a job inside the same transaction as the change that caused it
(`file.uploaded` is enqueued with the submission it belongs to); the worker claims jobs through three SECURITY DEFINER
functions (`jobs_claim/complete/fail`), runs the registered agents for that event, and will write **proposals**
back (tenant-scoped, with `agent_runs` for provenance) in Phase 3. The `taxops_worker` role has **no table privileges at all**. The app never calls the worker synchronously, so a slow or
failing model never blocks a user request.

## Security model

**Tenant isolation**
- Every table carries `tenant_id`; RLS policies compare it to a transaction-local setting (`app.tenant_id`) set by `withTenant()`.
- `FORCE ROW LEVEL SECURITY` applies to the table owner too. With no tenant set, queries return zero rows (fail closed).
- Parent/child links are **composite foreign keys** `(tenant_id, id)`, so a row can never reference another tenant's parent even if its UUID is known.
- The app connects as `taxops_app` (no DDL, no BYPASSRLS, no DELETE, insert-only on the audit table). Migrations run as `taxops_owner`.

**Authorization** (`packages/core/src/roles.ts`, enforced in `packages/services`)
- RBAC: `tenant_admin`, `tax_manager`, `tax_reviewer`, `contributor`, `auditor`, with fine-grained permissions.
- ABAC: contributors see only requests assigned to them, their department or their entity; drafts are hidden from them.
- Hidden objects return *not found*, never *forbidden*, so existence is not leaked.
- Segregation of duties: nobody reviews their own submission (checked server-side, also when roles change).
- Session role/scope is re-read from the database on every request; deactivation and role changes apply immediately.

**Audit trail** (`audit_events`)
- Appended in the **same transaction** as the change (both commit or neither does).
- `seq`, timestamp, `prev_hash`, `hash` are assigned by a DB trigger, so the app cannot forge or skip them; hashes chain over all fields.
- `UPDATE/DELETE/TRUNCATE` are blocked by privileges *and* triggers. `verify_audit_chain()` detects edits, deletions and reordering, even by someone who disables the triggers (covered by a test).

**Files (Phase 2)**
- Pipeline order: authorize → validate → malware-scan → write blob → commit rows + audit + job in one transaction; blobs are deleted if the commit fails. A rejected file blocks the whole submission and is audited as `file.rejected`.
- Validation is by *content*, never the client's claim: extension allow-list (xlsx, csv, pdf, docx, txt, png, jpg), magic bytes, OOXML structure, macro/executable parts refused, zip-bomb check from declared sizes **without inflating**, password-protected/legacy OLE refused, PDFs with scripts/launch/embedded files refused, UTF-8 text check, 25 MB per file / 10 files / 100 MB per submission. `.xls/.xlsm/.xlsb/.doc/.docm` are refused with guidance to re-save.
- Scanner is an interface: ClamAV over clamd INSTREAM, **fail-closed** (scanner down = upload refused). Dev uses an EICAR-only stub; production refuses to run without `CLAMAV_HOST`.
- Storage keys are `<tenant uuid>/<file uuid>` only (strict pattern, no overwrite), so user-supplied names can never reach a path. Display names are sanitized (paths, control and bidi characters).
- Every download/view is **re-authorized per request** (same visibility rules as the request; hidden = 404) and recorded as `file.downloaded` / `file.viewed`. Stored SHA-256 is re-checked on read to detect blob tampering.
- Downloads are `attachment` with `nosniff` and a `sandbox` CSP, `no-store`. The upload endpoint is same-origin-checked (CSRF) and size-capped.
- The viewer is read-only: formulas show cached values and are never evaluated; capped at 200 rows x 30 columns.

**AI agents (Phase 3)**
- **The worker's only door into the data is two SECURITY DEFINER functions**, both bound to the job it currently holds: `agent_get_file` (reads that job's file and the tenant's governance flags) and `agent_save_results` (writes run + proposals + rows + audit atomically). The tenant, file, request and item all come from the job, never from the caller; a crafted payload pointing at another tenant's file returns nothing. Saving is idempotent per (job, agent), so retries never duplicate output.
- **Proposals are not data.** Only the worker functions can create them; the app role can change just four decision columns, and a trigger allows exactly one transition (pending → accepted/rejected, with decider and time; a reason is required to reject). Decisions are final. A re-run supersedes earlier *pending* output for the same sheet and never touches decided proposals.
- **Two tenant switches, both default OFF:** `ai_extraction_enabled` (agent runs at all; otherwise a recorded "skipped" run) and `external_llm_enabled` (content may be sent to a model provider; otherwise the agent gets a gateway that refuses and uses deterministic matching). Operators set them with `pnpm tenant:flags`.
- **Code calculates, the model maps.** Header matching is deterministic and runs first; the model is consulted only when that is unsure *and* the tenant allows it. Whatever the model returns is **verified against the actual cells** (real columns, >=80% of amounts parse, rows labelled) or discarded. Amounts are parsed by code into exact decimals (strings end-to-end, never floats), including European formats, parentheses and trailing minus. A sheet's own total row is compared with the rows read, to expose missed rows.
- Prompts treat sheet text as fenced, untrusted data; the gateway redacts SSN/EIN/IBAN/card/email patterns; prompt version, model and call count are recorded per run.
- Confidence = 0.45 x header-match quality + 0.45 x amount parse rate + 0.10 x sample size (model answers capped at 0.9). It orders attention; it never auto-accepts anything.
- Every proposal row carries its source sheet/row/cell, linking into the file viewer. The proposal payload is validated in TypeScript against a golden sample (`schemas/fixtures/extraction_proposal.json`) that the Python tests also pin.
- Accepting means "this was read faithfully from the file". It does **not** mean the figures are correct; that is the validation agent's job (Phase 4).

**Validation (Phase 4)**
- Findings are produced only from **accepted** extractions; the worker's `agent_get_proposal` refuses anything else, and `agent_save_results` rejects a finding that does not reference the job's own source proposal. A re-validation retires pending findings it no longer raises; decided ones are never touched.
- All rules are plain arithmetic over exact decimals. A model may only *phrase* a finding, only if the tenant allows external model use, and its text is discarded if it contains any figure not present in the finding's own facts.
- The rule catalog is generated by the Python agent into one shared JSON file that the web app reads, and a test pins them together.

**Phase 5 hardening**
- **DB-enforced administration:** tenant AI switches and user management are guarded by triggers keyed to the acting user (`app.user_id`): tenant admins only, no self-demotion/deactivation, the last active admin can never be removed, email/tenant are immutable. The app-level services add friendly messages on top; the database is the authority.
- **Per-user notifications:** row policy lets anyone in the tenant create a notification but only the recipient read it. Created inside workflow transactions; de-duplicated; deadline sweep is idempotent.
- **Draft-only deletes:** the app may delete items/assignments, but a trigger refuses unless the request is still a draft.
- **Audit export** ships the exact hashed text per event; `scripts/verify-audit-export.mjs` re-derives the chain with SHA-256 alone and detects edits, forged hashes, removed and reordered events. The export is itself audited (after being produced).
- **Structural tests** read the live catalog and fail if any tenant table lacks forced RLS, any foreign key between tenant tables is not tenant-composite, any `SECURITY DEFINER` function lacks a pinned `search_path` or is PUBLIC-executable, or any broad owner policy appears beyond the three reviewed ones. A **role x operation matrix** invokes every gated service operation as every role and checks it against the permission table (mutation-tested: removing a check fails it), and a **cross-tenant matrix** tries every operation against another tenant's objects.
- **Lesson recorded:** an early version of the metrics function added broad owner-read policies, which silently widened every other SECURITY DEFINER function. The introspection suite now forbids that; cross-tenant counts live in one aggregate-only function owned by a dedicated `BYPASSRLS` role that cannot log in.
- **SSO:** OIDC authorization-code + PKCE; ID tokens verified (signature, issuer, audience, expiry, nonce, algorithm allow-list), verified email required by default, users matched to existing accounts only (never created implicitly), in-flight state in a short-lived signed HttpOnly cookie. Production refuses `AUTH_MODE=dev`. Covered against a mock provider in unit tests and a full browser flow.
- **Operations:** JSON structured logs with redaction (web and worker; worker logs exception *types* only), request ids, `/api/health`, `/api/ready`, token-protected Prometheus `/api/metrics` (aggregate counts only), per-endpoint rate limits on sign-in, uploads and exports.
- Dependency audit: `pnpm audit --prod` and `pip-audit` are clean (a transitive `uuid` advisory is overridden to the patched release).

**Application**
- Security headers (CSP `frame-ancestors`, HSTS, nosniff, etc.), `poweredByHeader` off, server actions have Next's built-in origin checks.
- Domain errors are mapped to safe messages; unknown errors are logged, never returned.
- Dev auth is disabled in production and the app refuses `AUTH_MODE=dev` with `NODE_ENV=production`.
- LLM gateway redacts SSN/EIN/IBAN/card/email patterns before any prompt leaves, never echoes provider errors or content, and requires schema-validated output. **Spreadsheet content is treated as untrusted data** (prompt-injection posture): agents get no write tools beyond emitting proposals.

## Data model (summary)

`tenants → legal_entities, departments, users` · `requests → request_items, assignments` · `request_items → submissions (versioned) → reviews` ·
`comments` · `audit_events`. Overdue is *derived* from due date; request status is *derived* from item statuses (`deriveRequestStatus`) except `draft` and `closed`, which are explicit decisions.

## Request lifecycle

`draft → open → in progress → in review → approved → closed`, with `changes requested` looping back. Items move
`pending → submitted → approved | changes requested → submitted…`. Illegal transitions are rejected in `packages/core/src/status.ts`.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | Monorepo, design system, tenancy/RLS, audit primitive, fictional seed, agent contract | Done |
| 1 | Dashboard, requests, assignments, deadlines, review workflow, audit UI | Done |
| 2 | File upload (versioning, malware scan, authorized downloads), Excel viewer, `jobs` queue + worker loop | Done |
| 3 | Extraction agent (Python + Gemini), canonical schema, proposal review UI | Done (trial balance only) |
| 4 | Validation agent (deterministic rules + LLM explanations), finding triage, approval | |
| 5 | Hardening: permission/isolation suites, audit export, observability, notifications, SSO, administration | Done |

## Document agent, reports, templates and mentions

- **Document agent** (`services/agent-worker/.../agents/documents`): listens to `file.uploaded` for PDF/Word/text (it declines spreadsheets without recording a run). Text is read with bounded, defused parsers (PDF page/size caps, DTDs refused in Word files). Dates, amounts, years, signature wording and a document type come from plain patterns. If the tenant allows an external model it may add a summary, counterparty and period; **anything not literally present in the document text is discarded**. The result is an `extraction` proposal with `schema: supporting_document` that a person accepts or rejects; accepting it starts no validation. Its shape is pinned by `schemas/fixtures/document_proposal.json` on both sides.
- **Reconciliation agent** (`agents/reconciliation`): when a person accepts a trial balance or a balance confirmation, it compares the accepted confirmations with the accepted trial balances **of the same request**. It reads them through `agent_get_related()`, one size-capped database function bound to the job it holds: only accepted extractions of the same request, rows for trial balances only. Four rules (amount not in the books, direction, currencies not comparable, agreement recorded) use exact decimals; no model decides whether figures agree. It does not know which entity a trial balance belongs to, and says so in the direction finding. `agent_save_results` now retires only the **same agent's** earlier open findings, so two agents can work on one accepted proposal without erasing each other.
- **Currency on every result:** the Reader records a currency from the title rows, column headers, sheet name, or unambiguous symbols (`S$`, `R$`, `€`, `£`), and says where it came from. Conflicting mentions or a bare `$` produce no guess. The review page, review list and approved data pack show it; the Reconciler never compares amounts across currencies.
- **Validation rules** added: suspense/clearing balances, mostly-round balances, and intercompany balances to confirm (11 rules in total; each can be switched off or tuned in Settings).
- **Reports** (`report.read`: tax manager, reviewer, auditor, tenant admin): status report with completion, time-to-close and on-time rate; CSV export; and a per-request **approved data pack** containing only data a person accepted, with source cells. Exports are `POST` + same-origin, rate limited, formula-neutralised and audited.
- **Request templates**: a request's title and items (never assignees, dates or data) can be saved and reused. Tax managers only, enforced in the app and by a database trigger. Templates are archived, never deleted.
- **@mentions** in comments notify the named person only if they can already see the request (tenant-wide roles, or an assignee of a published request), so a mention can never reveal a request.

## UI design system

Web-first, following Apple's interface principles. All tokens live in `apps/web/src/app/globals.css`; re-skinning means changing tokens only.

- **Response:** press feedback is `:active` (fires on pointer-down) with a spring release; controls are 44px tall on coarse pointers.
- **Motion:** CSS `linear()` damped springs (`--spring-smooth` ζ=1.0 by default, `--spring-bouncy` ζ=0.8 only for momentum such as the switch thumb and toasts). The confirmation sheet follows the finger 1:1, rubber-bands upward and projects release velocity to decide dismiss vs settle.
- **Navigation:** translucent sidebar on desktop, translucent bottom tab bar plus a "More" sheet on phones; `useLinkStatus` shows a pending state on press; sticky toolbar becomes a material only once content scrolls under it and shows the page title after the large title scrolls away.
- **Feedback:** consequential actions (publish, close, send back, deactivate, external AI) use a native `<dialog>` confirmation (`components/overlays.tsx`); completions use toasts. No `window.confirm`.
- **Type:** system font stack with size-specific tracking (tight for large titles, none for small text); tabular numerals for figures.
- **Accessibility:** `prefers-reduced-motion` (no movement, opacity only), `prefers-reduced-transparency` (solid surfaces), `prefers-contrast: more` (defined borders); tables stack into labelled rows on phones.

## Security audit (post-build)

A full audit after Phase 5 found one High, five Medium and ten Low issues; every finding was reproduced before being reported.
Fixed, each with a regression test:

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | App role could rewrite review decisions, submission notes, comments, request references, assignments and entity names | Column-level grants only (pinned by a structural test); published requests' content guarded by a trigger |
| 2 | Medium | Error logs contained bound query values (notes, emails, IDs) | Parameters stripped from all logged messages |
| 3 | Medium | "Required" flag ignored: an untouched optional item blocked approval forever | Untouched optional items no longer block; engaged ones still need review |
| 4 | Medium | The example `AUTH_SECRET` would have been accepted in production | Placeholder/predictable secrets rejected; unsafe production config refuses to start |
| 5 | Medium | Uploads without a size header were buffered in memory without limit | Streaming byte cap; missing length -> 411 |
| 6 | Medium | Remap/re-process ran while the tenant's AI switch was off | Enforced in both the services and the agent |
| 9 | Low | No script Content-Security-Policy | Per-request nonce + `strict-dynamic` (verified in a production build) |
| 10 | Low | `defusedxml` undeclared; DTD-bearing Office files accepted | Declared; DTDs/entities rejected at upload (bounded prefix scan) |
| 11 | Low | Notification redirect accepted `/\evil.com` | Strict same-site path check |
| 12 | Low | Sheet name sat outside the prompt's data fence | Moved inside |
| 13 | Low | No statement timeouts | 15 s (web) / 60 s (worker), plus idle-in-transaction timeouts |
| 14 | Low | `/api/ready` exposed queue depth anonymously | Returns status only |
| 15 | Low | Notification trigger changed the transaction's tenant setting | Restores it |

The three items first accepted as known risks were fixed afterwards:

| # | Severity | Finding | Fix |
|---|---|---|---|
| 7 | Low | Sign-out did not revoke a copied session token | Tokens carry their issue time; sign-out calls `revoke_my_sessions()`, which stamps `users.tokens_valid_after` (own row only), and every request rejects older tokens. This signs the person out on all their devices. |
| 8 | Low | Rate limits trusted a client-forgeable `X-Forwarded-For` | The header is believed only through `TRUSTED_PROXY_HOPS` proxies you run (entry taken from the right); default 0 ignores it. Production refuses to start unless the variable is set. |
| 16 | Low | The dev sign-in helper function shipped in the schema | Dropped by migration; `db:seed`/`db:reset` install it for local development only, so a production database never has it. |

## Known limitations (read before production)

**Security and identity**
- **Dev sign-in is passwordless** and must never be exposed (production refuses it). SSO is implemented and tested against a mock provider, **not against a real IdP**: verify claims (`email_verified`, issuer format, key rotation) with yours. There is no SCIM provisioning or group-to-role mapping yet; admins add people by email.
- **Rate limiting is per server instance** (in memory). Set `TRUSTED_PROXY_HOPS` to match your deployment. Behind several instances, enforce limits at the edge or use a shared store.
- **Sign-out revokes every session the person holds** (all devices), not just the current one; there is no per-device session list yet.
- Contributor scoping is enforced in the service layer (tenant isolation is RLS). Pushing per-user scope into RLS is a candidate hardening step.
- **The dev malware scanner is a stub** (EICAR only) and the ClamAV client was only tested against a fake clamd. Production refuses to start uploads without `CLAMAV_HOST`. Dev storage is unencrypted local disk; production needs object storage with KMS (`FileStorage`/`BlobStorage` are the seams). No retention/legal-hold policy yet.
- Audit writes serialize per tenant (gap-free chain). Integrity verification is O(n) and on demand. The export is capped at 50,000 events per request.
- No MFA of its own (delegate to the IdP) and no session revocation list beyond role/active re-checks on every request.

**AI**
- **The Gemini path has never run against the live API**; it is tested with a fake gateway only (hallucinated columns, prompt injection, redaction, number-guard on explanations). Confirm `GEMINI_MODEL` and your provider's retention terms first.
- Extraction and validation cover **trial balances only**, with English and a few German header synonyms. The "usual side" rule assumes standard 1xxx-8xxx numbering and can be a false alarm (it says so). Rules look at one file at a time: there is **no cross-entity or year-over-year validation** yet (it needs prior-period data and a cross-file data model). The intercompany rule only lists balances to confirm.
- The **document agent** reads text-based PDF, Word and text files. Scanned PDFs have no text layer and are reported as unreadable (no OCR). It extracts facts for a person to check; it does not decide whether a document is genuine or signed.
- Accepted data feeds validation but nothing downstream (returns, workpapers, ERP connectors) yet.

**Product**
- No email/push delivery for notifications (in-app only); the deadline sweep must be scheduled by the operator. The review queue lists proposals individually (no grouping by file). Tenant AI switches and rules apply from the next job.
- Files are stored on local disk; there is **no object-storage (S3-compatible) adapter yet**. `FileStorage`/`BlobStorage` are the seams and the worker reads the same directory as the web app in dev.
- The Python worker reads blobs from the same storage directory as the web app (local disk in dev).
- `docker-compose.yml` and the CI workflow were written but **not executed in the authoring environment** (no Docker daemon). CI runs unit/integration suites; the two browser end-to-end scripts are run manually.
