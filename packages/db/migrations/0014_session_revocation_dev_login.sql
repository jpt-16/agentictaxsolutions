-- 1) Server-side sign-out. Session tokens carry their issue time (ms); a token issued before users.tokens_valid_after is void.
--    The function runs as the owner (the app role cannot write that column directly) and only ever touches the CALLER's own row.
CREATE FUNCTION revoke_my_sessions() RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  IF app_user_id() IS NULL OR app_tenant_id() IS NULL THEN
    RAISE EXCEPTION 'no signed-in user' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE users SET tokens_valid_after = clock_timestamp() WHERE id = app_user_id() AND tenant_id = app_tenant_id();
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION revoke_my_sessions() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION revoke_my_sessions() TO taxops_app;
--> statement-breakpoint

-- 2) The development sign-in picker no longer ships in migrations: a production database simply does not have this function.
--    Development tooling (db:seed / db:reset) installs it with the owner role (see packages/db/src/dev-login.ts).
DROP FUNCTION IF EXISTS auth_dev_list_users(text);
--> statement-breakpoint

-- The ORM names every column in an INSERT (as DEFAULT), so the app role needs INSERT on the new column; it still cannot UPDATE it.
GRANT INSERT (tokens_valid_after) ON users TO taxops_app;
