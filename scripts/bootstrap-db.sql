-- One-time cluster/database bootstrap. Run as a Postgres superuser:
--   psql -h localhost -p 5433 -U postgres -d postgres -f scripts/bootstrap-db.sql
--
-- Two roles, on purpose:
--   taxops_owner : owns the schema, runs migrations/seed. Not a superuser; RLS is FORCED on its tables too.
--   taxops_app   : what the running application uses. Cannot alter schema, cannot bypass RLS,
--                  and has INSERT-only access to the audit table (granted in the migrations).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'taxops_owner') THEN
    CREATE ROLE taxops_owner LOGIN PASSWORD 'taxops_owner' NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'taxops_app') THEN
    CREATE ROLE taxops_app LOGIN PASSWORD 'taxops_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'taxops_worker') THEN
    -- The AI/agent worker. Has NO table privileges: it can only call the jobs_* functions granted in migrations.
    CREATE ROLE taxops_worker LOGIN PASSWORD 'taxops_worker' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

SELECT 'CREATE DATABASE taxops OWNER taxops_owner' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'taxops') \gexec
SELECT 'CREATE DATABASE taxops_test OWNER taxops_owner' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'taxops_test') \gexec
ALTER DATABASE taxops OWNER TO taxops_owner;

\c taxops
ALTER SCHEMA public OWNER TO taxops_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO taxops_app, taxops_worker;

\c taxops_test
ALTER SCHEMA public OWNER TO taxops_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO taxops_app, taxops_worker;
