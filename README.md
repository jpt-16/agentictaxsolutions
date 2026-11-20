# Tax Operations — AI Tax Data Collection & Validation (MVP)

An enterprise platform where tax teams request data from departments and subsidiaries, collect it, and (in later
phases) have AI agents standardize and validate it, with human review and a tamper-evident audit trail.

> **Status: Phases 0 + 1.** The workflow core (requests, assignments, deadlines, statuses, review, audit) is built and
> tested. File upload and the AI agents are Phases 2–4. **All data is fictional. Do not connect real corporate data.**

## What works today

- Professional dashboard with role-aware KPIs, deadlines, a personal work queue and activity feed
- Tax managers create requests with items, assign them to departments, subsidiaries or people, set deadlines
- Contributors submit; reviewers approve or request changes; request status is derived from item state
- Role-based access (5 roles) plus attribute-based scoping (contributors only see what is assigned to them)
- Segregation of duties (no self-review), tenant isolation enforced in Postgres (RLS)
- Append-only, hash-chained audit history with an integrity verifier
- Python agent runtime foundation (agent contract, registry, Gemini gateway with redaction), not yet wired to jobs

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
node scripts/e2e-smoke.cjs         # full UI workflow; needs `pnpm dev` + fresh seed + Playwright
cd services/agent-worker && pip install -e ".[dev]" && pytest
```

The database tests run against a separate `taxops_test` database that they reset on every run.

## Repository layout

| Path | Purpose |
|---|---|
| `apps/web` | Next.js UI and server actions (thin; no business rules) |
| `packages/core` | Pure domain: roles, permissions, status machine, validation schemas |
| `packages/db` | Drizzle schema, SQL migrations (RLS, audit trigger), tenant-scoped connection helper |
| `packages/services` | Use cases: authorization + scoping + state transitions + audit, in one transaction |
| `services/agent-worker` | Python agent runtime: contract, registry, LLM gateway |
| `docs/architecture.md` | Decisions, security model, data model, roadmap, known limitations |

See [docs/architecture.md](docs/architecture.md) before changing anything security-relevant.
