import { sql } from "drizzle-orm";
import type { Db } from "./client";

/**
 * DEVELOPMENT ONLY. The sign-in picker needs to list users before anyone is signed in, which no production database should allow,
 * so the function that does it is not part of the migrations. `db:seed` and `db:reset` (which refuse non-local databases) install it
 * here; a production database never has it, whatever the application configuration says.
 */
export async function installDevLogin(ownerDb: Db): Promise<void> {
  await ownerDb.execute(sql`
    CREATE OR REPLACE FUNCTION auth_dev_list_users(p_slug text)
      RETURNS TABLE (user_id uuid, name text, email text, title text, role role)
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
      AS $fn$
    BEGIN
      IF coalesce(current_setting('app.allow_dev_login', true), '') <> 'on' THEN
        RAISE EXCEPTION 'dev login is disabled' USING ERRCODE = 'insufficient_privilege';
      END IF;
      RETURN QUERY
        SELECT u.id, u.name, u.email, u.title, u.role
        FROM users u JOIN tenants t ON t.id = u.tenant_id
        WHERE t.slug = p_slug AND u.is_active ORDER BY u.role, u.name;
    END $fn$`);
  await ownerDb.execute(sql`REVOKE ALL ON FUNCTION auth_dev_list_users(text) FROM PUBLIC`);
  await ownerDb.execute(sql`GRANT EXECUTE ON FUNCTION auth_dev_list_users(text) TO taxops_app`);
}
