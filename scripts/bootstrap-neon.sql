-- One-time bootstrap for a hosted Postgres (Neon). Run ONCE as the project's owner role, connected to the database you will use.
-- Passwords are inputs, never defaults:
--   psql "$NEON_ADMIN_URL" -v ON_ERROR_STOP=1 -v owner_pw="$OWNER_PW" -v app_pw="$APP_PW" -v worker_pw="$WORKER_PW" -f scripts/bootstrap-neon.sql
-- Same four roles and privileges as scripts/bootstrap-db.sql (see the comments there), without the dev passwords and without creating databases.
SELECT format('CREATE ROLE taxops_owner LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS', :'owner_pw')
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'taxops_owner') \gexec
SELECT format('CREATE ROLE taxops_app LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', :'app_pw')
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'taxops_app') \gexec
SELECT format('CREATE ROLE taxops_worker LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', :'worker_pw')
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'taxops_worker') \gexec
SELECT 'CREATE ROLE taxops_ops NOLOGIN NOSUPERUSER BYPASSRLS'
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'taxops_ops') \gexec

-- Re-running rotates the passwords to the values you pass in.
ALTER ROLE taxops_owner PASSWORD :'owner_pw';
ALTER ROLE taxops_app PASSWORD :'app_pw';
ALTER ROLE taxops_worker PASSWORD :'worker_pw';

GRANT taxops_ops TO taxops_owner;
-- Ownership handover happens once. If taxops_owner already owns this database, a re-run only rotates the passwords above.
SELECT (pg_get_userbyid(datdba) = 'taxops_owner') AS handed_over FROM pg_database WHERE datname = current_database() \gset
\if :handed_over
  \echo Database already owned by taxops_owner: passwords rotated, nothing else to do.
\else
-- Privileges on the public schema are set while this session still owns the database.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO taxops_app, taxops_worker, taxops_ops;
-- Postgres 15+: public is owned by pg_database_owner, so it follows the database owner automatically. Only move it by hand otherwise.
SELECT 'ALTER SCHEMA public OWNER TO taxops_owner'
  WHERE (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'public') NOT IN ('pg_database_owner', 'taxops_owner') \gexec
-- Postgres 16+: the creator of a role gets ADMIN rights on it but not the right to SET ROLE to it, which ALTER ... OWNER TO requires.
SELECT format('GRANT taxops_owner TO %I WITH SET TRUE, INHERIT FALSE', current_user) WHERE NOT pg_has_role(current_user, 'taxops_owner', 'SET') \gexec
SELECT format('ALTER DATABASE %I OWNER TO taxops_owner', current_database()) \gexec
\endif
