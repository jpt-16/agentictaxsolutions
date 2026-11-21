# Deploying Pelloria with Neon Postgres

This covers the database. The web app and the Python worker also need a host that can run long-lived processes (Fly.io, Render or Railway all work); that choice is separate and the app is configured only through environment variables.

Everything below was rehearsed on a scratch Postgres 16 database (bootstrap, all migrations, tenant creation). It has not been run against Neon itself, so treat the first run as a dry run.

## Fast path (recommended)

The project `young-mode-16349869` is linked in `neon.ts`. On a machine that can reach your Neon database (a cloud sandbox cannot: database traffic is not HTTPS), with `psql` and `pnpm` installed:

```bash
neon login
```

```bash
neon env pull
```

```bash
bash scripts/neon-setup.sh
```

This creates the four roles with fresh random passwords, applies all migrations as the owner role and writes the three connection strings to `.env.neon` (git-ignored, never printed). Re-running it is safe and rotates the passwords. Then create the first tenant (step 4 below). The numbered steps that follow are the same thing done by hand.

> **Postgres version.** The tests run on Postgres 16, but a Neon project created from the console can default to a newer version (this one is on 18). Newer versions are expected to work but are untested here: run `pnpm test` against your database version before trusting it, or create the project on 16.

## 1. Create the database

1. Create a Neon project. Choose **Postgres 16**, the version the test suites run on, and a region close to your app host.
2. Keep the default database. Copy the **direct** connection string for the project owner role (the one Neon created), with **Connection pooling switched off**. Its host has no `-pooler` in it.

> **Do not use the pooled endpoint.** The app sets a per-connection statement timeout as a startup option, which Neon's pooler rejects, and the worker holds job state on a single connection. Use direct connections for the app, the worker and migrations.

## 2. Create the roles (once)

Generate three different long passwords, then run the bootstrap as the Neon owner role:

```bash
export OWNER_PW="$(openssl rand -base64 32 | tr -d '/+=')"
export APP_PW="$(openssl rand -base64 32 | tr -d '/+=')"
export WORKER_PW="$(openssl rand -base64 32 | tr -d '/+=')"
```

```bash
psql "$NEON_ADMIN_URL" -v ON_ERROR_STOP=1 -v owner_pw="$OWNER_PW" -v app_pw="$APP_PW" -v worker_pw="$WORKER_PW" -f scripts/bootstrap-neon.sql
```

Store the three passwords in your secret manager. This creates `taxops_owner` (runs migrations), `taxops_app` (what the app uses; cannot change the schema or bypass row-level security) and `taxops_worker` (can only call its own job functions).

## 3. Connection strings

Replace `HOST` and `DB` with the direct host and database name from step 1. Every string needs `sslmode=require`.

```
DATABASE_OWNER_URL=postgres://taxops_owner:<OWNER_PW>@HOST/DB?sslmode=require
DATABASE_URL=postgres://taxops_app:<APP_PW>@HOST/DB?sslmode=require
WORKER_DATABASE_URL=postgres://taxops_worker:<WORKER_PW>@HOST/DB?sslmode=require
```

Only the migration step ever needs `DATABASE_OWNER_URL`; do not give it to the running app.

## 4. Migrate and create the first tenant

```bash
pnpm db:migrate
```

```bash
pnpm tenant:create --slug acme --name "Acme Corp" --admin-email jane@acme.com --admin-name "Jane Doe"
```

The admin signs in through SSO and adds everyone else from Settings. Both AI processing and external model providers start **off**. Turn extraction on when you are ready:

```bash
pnpm tenant:flags acme --ai on
```

Never run `db:seed` or `db:reset` against production: they load fictional demo data (and `db:reset` drops everything).

## 5. Production settings the app insists on

Set `NODE_ENV=production`, `AUTH_MODE=oidc` with the `OIDC_*` variables, a strong `AUTH_SECRET` (`openssl rand -base64 48`), `TRUSTED_PROXY_HOPS`, and `CLAMAV_HOST` (uploads are refused in production without a real virus scanner). See `.env.example` for each name. Also set a hard monthly spending cap in each AI provider's console.

## Not ready yet: file storage

Only local-disk storage (`STORAGE_DIR`) is implemented. The code has a storage interface for S3/GCS (`packages/services/src/files/storage.ts`) but no S3 adapter yet. The web app and the worker both read uploaded files, so today they must run on the same machine and the same disk volume. Before running them on separate hosts, build an S3-compatible adapter with server-side encryption. Until then, run both in one container or one VM with a persistent volume.

## Notes

- Neon compute can suspend when idle, so the first request after a quiet period is slower. Disable auto-suspend for a production project if that matters.
- Back up with Neon's point-in-time restore, and keep the audit export from the app as an independent, verifiable copy.
