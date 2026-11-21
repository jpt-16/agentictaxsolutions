# Tax Operations — AI Tax Data Collection & Validation (MVP)

An enterprise platform where tax teams request data from departments and subsidiaries, collect it, and (in later
phases) have AI agents standardize and validate it, with human review and a tamper-evident audit trail.

> **Status: all planned phases (0–5) built.** Workflow, secure files, AI extraction and validation with human review, notifications,
> administration, SSO, audit export and operational tooling. See `docs/architecture.md` for what is deliberately not done yet. **All data is fictional. Do not connect real corporate data.**

## What works today

- Professional dashboard with role-aware KPIs, deadlines, a personal work queue and activity feed
- Tax managers create requests with items, assign them to departments, subsidiaries or people, set deadlines
- Contributors submit; reviewers approve or request changes; request status is derived from item state
- Role-based access (5 roles) plus attribute-based scoping (contributors only see what is assigned to them)
- Segregation of duties (no self-review), tenant isolation enforced in Postgres (RLS)
- Append-only, hash-chained audit history with an integrity verifier
- AI agents (Python worker): trial-balance extraction, rule-based validation (11 rules) and a document reader for PDF/Word/text; every AI result is reviewed and accepted or rejected by a person
- Reports and CSV exports (status report, approved data pack), request templates, @mentions, notifications, SSO, audit export
- Sample files for trying it: see `samples/README.md`

## Quick start

Requires Node 22+, pnpm 10, PostgreSQL 16 (or Docker), Python 3.11+ for the agent worker.

```bash
cp .env.example .env            # defaults work for local development
pnpm install
```

Start Postgres and create the two database roles. With Docker (the bootstrap script runs automatically):

```bash
docker compose up -d db
```

Or against your own local Postgres (superuser connection):

```bash
psql -h localhost -p 5433 -U postgres -d postgres -f scripts/bootstrap-db.sql
```

Then:

```bash
pnpm db:migrate && pnpm db:seed   # schema + fictional "Northwind Holdings" data
pnpm dev                          # http://localhost:3000
```

Sign in by picking a persona on the login page (development-only, no password):
**Marcus Hale** (Tax Manager), **Tomas Berg** (Reviewer), **Lena Fischer** (Contributor, Germany),
**Grace Okafor** (Auditor), **Priya Raman** (Admin).

`pnpm db:reset` wipes the dev database and reseeds it (refuses non-local hosts).

## Tests

```bash
pnpm typecheck
pnpm test                          # core + database security + services (needs the local Postgres above)
node scripts/e2e-smoke.cjs         # full UI workflow; needs `pnpm dev` + fresh seed + Playwright (+ WORKER_CMD for the AI steps)
node scripts/e2e-sso.cjs           # SSO flow against the local mock identity provider (starts its own server)
cd services/agent-worker && pip install -e ".[dev]" && pytest   # worker tests need the Postgres test DB (run `pnpm test` first)
```

Process uploaded files with the AI worker (drains the queue and exits; omit `--once` to keep it running):

```bash
cd services/agent-worker && pip install -e . && cd ../.. && pnpm worker:once
```

The worker reads the repo `.env`. With no `GEMINI_API_KEY`, or while a tenant has external LLM off (the default), extraction
uses deterministic header matching only and no content leaves the system. To allow the model for a tenant:
`pnpm tenant:flags northwind --external-llm on`.

The database tests run against a separate `taxops_test` database that they reset on every run.

## Repository layout

| Path | Purpose |
|---|---|
| `apps/web` | Next.js UI and server actions (thin; no business rules) |
| `packages/core` | Pure domain: roles, permissions, status machine, validation schemas |
| `packages/db` | Drizzle schema, SQL migrations (RLS, audit trigger), tenant-scoped connection helper |
| `packages/services` | Use cases: authorization + scoping + state transitions + audit, in one transaction |
| `services/agent-worker` | Python agent runtime: contract, registry, LLM gateway, extraction / validation / document agents |
| `docs/architecture.md` | Decisions, security model, data model, roadmap, known limitations |

See [docs/architecture.md](docs/architecture.md) before changing anything security-relevant.

## Operations cheat sheet

| Task | Command |
|---|---|
| Process uploaded files / validation | `pnpm worker:once` (or run `python -m taxops_agents` as a service) |
| Deadline reminders (run on a schedule) | `pnpm notify:sweep` |
| Tenant AI switches from the CLI | `pnpm tenant:flags <slug> --ai on --external-llm off` |
| Verify an audit export offline | `node scripts/verify-audit-export.mjs audit.json` |
| Local identity provider for SSO | `node scripts/mock-idp.mjs` |
| Liveness / readiness / metrics | `/api/health`, `/api/ready`, `/api/metrics` (bearer `METRICS_TOKEN`) |
