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
| 5 | Hardening: permission/isolation suites, audit export, observability, notifications, SSO | |

## Known limitations (deliberate for this phase)

- **Dev sign-in is passwordless** and must never be exposed. The login-lookup DB function is gated by an app-set flag, which is weak by design and removed with SSO.
- **Contributor scoping is enforced in the service layer**, not RLS (tenant isolation *is* RLS). Pushing per-user scope into RLS is a candidate hardening step.
- **Audit writes serialize per tenant** (advisory lock) to guarantee a gap-free chain. Fine at MVP scale; shard or batch-seal later if write volume demands it. Integrity verification is O(n), so it runs on demand, not on every page load.
- Dashboard aggregation is computed in application code over the visible set; move to SQL aggregates if tenants grow large.
- No notifications, draft editing, or user management UI yet.
- The Gemini gateway is unit-tested with a stub client but **has not been run against the live API**. Confirm the model id (`GEMINI_MODEL`) and data-retention terms before sending anything but fictional data.
- The queue and worker loop exist and are tested, but **no agents are registered yet**, so `file.uploaded` jobs simply wait in the queue until Phase 3.
- `docker-compose.yml` and the CI workflow are written but were not executed in the authoring environment (no Docker daemon there).
- **Dev scanner is a stub** (EICAR only). The ClamAV client is tested against a fake clamd, not a real one. Do not accept files from real users without a real scanner; production refuses to start uploads without `CLAMAV_HOST`.
- **Dev storage is unencrypted local disk.** Production needs S3/GCS with KMS encryption; the `FileStorage` interface is the seam. Downloads stream through an authenticated route rather than presigned URLs, which keeps every access audited but means the app proxies the bytes.
- Uploads are scanned and stored **synchronously** inside the request and buffered in memory (bounded by the limits above). Spreadsheet previews parse in-process. Move both to the worker with streaming if volumes or abuse require it.
- Files are immutable by design (no delete/replace); a retention and legal-hold policy still needs to be defined.
- Uploading is optional per submission (note-only is allowed); requiring a file per item type is a product decision for later.
- **Extraction covers trial balances only** (English and a few German header synonyms). Other workbook types get an honest "no data extracted" result. More canonical schemas (fixed assets, intercompany, transfer pricing) are straightforward additions to the agent.
- **No mapping-correction UI yet.** A reviewer can reject with a reason, but cannot adjust the column mapping and re-extract in place, and there is no "re-run" button (a re-run supersedes pending output; trigger it by re-enqueuing the job).
- **Accepted proposals do not feed anything downstream yet.** They are the reviewed source for Phase 4's validation.
- **The model path has never run against the live Gemini API** (no key here): it is covered with a fake gateway, including hallucinated columns, prompt-injection text and redaction. Verify before relying on it.
- Tenant AI switches have a CLI but no admin UI. The review queue lists proposals individually (no grouping by file yet).
- The Python worker reads blobs from the same storage directory as the web app (local disk in dev). Production needs an S3/GCS reader behind `BlobStorage`.
