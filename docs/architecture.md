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
| Queue (planned, Phase 3) | Postgres `jobs` table, `FOR UPDATE SKIP LOCKED` | **Changed from the original proposal (pg-boss).** pg-boss is Node-only; a plain SQL queue is language-neutral so the Python worker can consume it with no extra infrastructure |
| Auth | Dev persona picker (stub); OIDC/SAML SSO planned | Downstream code only needs the session cookie and `loadSession()` |

### How the TypeScript app and Python worker meet
Both talk to the same Postgres. The web app enqueues a job inside the same transaction as the change that caused it
(e.g. `submission.created`); the worker claims jobs, runs the registered agent for that event, and writes **proposals**
back (tenant-scoped, with `agent_runs` for provenance). The app never calls the worker synchronously, so a slow or
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
| 2 | File upload (versioning, virus scan, signed URLs), Excel viewer, `jobs` table | Next |
| 3 | Extraction agent (Python + Gemini), canonical schemas, proposal review UI | |
| 4 | Validation agent (deterministic rules + LLM explanations), finding triage, approval | |
| 5 | Hardening: permission/isolation suites, audit export, observability, notifications, SSO | |

## Known limitations (deliberate for this phase)

- **Dev sign-in is passwordless** and must never be exposed. The login-lookup DB function is gated by an app-set flag, which is weak by design and removed with SSO.
- **Contributor scoping is enforced in the service layer**, not RLS (tenant isolation *is* RLS). Pushing per-user scope into RLS is a candidate hardening step.
- **Audit writes serialize per tenant** (advisory lock) to guarantee a gap-free chain. Fine at MVP scale; shard or batch-seal later if write volume demands it. Integrity verification is O(n), so it runs on demand, not on every page load.
- Dashboard aggregation is computed in application code over the visible set; move to SQL aggregates if tenants grow large.
- No file upload, notifications, draft editing, or user management UI yet.
- The Gemini gateway is unit-tested with a stub client but **has not been run against the live API**. Confirm the model id (`GEMINI_MODEL`) and data-retention terms before sending anything but fictional data.
- The `jobs` table and worker poll loop do not exist yet (Phase 2/3); the Python package currently contains the contract, registry and gateway only.
- `docker-compose.yml` and the CI workflow are written but were not executed in the authoring environment (no Docker daemon there).
