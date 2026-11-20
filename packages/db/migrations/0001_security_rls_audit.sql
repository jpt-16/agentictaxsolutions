-- Security layer: tenant isolation (RLS), least-privilege grants, and the tamper-evident audit trail.
-- Statements are separated by drizzle breakpoints so function bodies run as single statements.

-- ---------------------------------------------------------------------------------------------
-- 1. Tenant context + row-level security
--    The application sets `app.tenant_id` (transaction-local) before running any query.
--    If it is unset, app_tenant_id() is NULL and every policy matches zero rows (fail closed).
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION app_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenants USING (id = app_tenant_id()) WITH CHECK (id = app_tenant_id());
--> statement-breakpoint

ALTER TABLE legal_entities ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE legal_entities FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON legal_entities USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint

ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE departments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON departments USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE users FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON users USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint

ALTER TABLE requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON requests USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint

ALTER TABLE request_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE request_items FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON request_items USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint

ALTER TABLE assignments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE assignments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON assignments USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint

ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE submissions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON submissions USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint

ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE reviews FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON reviews USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint

ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE comments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON comments USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON audit_events USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. Least-privilege grants for the application role. No DELETE anywhere; audit is insert-only.
-- ---------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON tenants, legal_entities, departments, users, requests, request_items,
  assignments, submissions, reviews, comments TO taxops_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON audit_events TO taxops_app;
--> statement-breakpoint
-- Tenants are provisioned by operators, not by the running app.
REVOKE INSERT, UPDATE ON tenants FROM taxops_app;
--> statement-breakpoint

-- Assignment targets must be unique per request (a department can't be assigned twice, etc.).
CREATE UNIQUE INDEX assignments_unique_department ON assignments (request_id, department_id) WHERE assignee_type = 'department';
--> statement-breakpoint
CREATE UNIQUE INDEX assignments_unique_entity ON assignments (request_id, entity_id) WHERE assignee_type = 'entity';
--> statement-breakpoint
CREATE UNIQUE INDEX assignments_unique_user ON assignments (request_id, user_id) WHERE assignee_type = 'user';
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. Tamper-evident audit trail
--    seq, occurred_at, prev_hash and hash are assigned HERE, never by the application.
--    The hash covers every business field plus the previous event's hash, so editing,
--    deleting or reordering history breaks the chain and is detectable by verify_audit_chain().
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION audit_hash(
  p_prev text, p_tenant uuid, p_seq bigint, p_at timestamptz, p_actor_type text, p_actor_id uuid,
  p_actor_label text, p_action text, p_entity_type text, p_entity_id uuid, p_request_ref uuid,
  p_summary text, p_before jsonb, p_after jsonb
) RETURNS text
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT encode(sha256(convert_to(jsonb_build_array(
      p_prev, p_tenant, p_seq,
      to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
      p_actor_type, p_actor_id, p_actor_label, p_action, p_entity_type, p_entity_id, p_request_ref,
      p_summary, p_before, p_after
    )::text, 'UTF8')), 'hex')
  $$;
--> statement-breakpoint

CREATE FUNCTION audit_events_chain() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  last_seq bigint;
  last_hash text;
BEGIN
  -- Serialize audit writes per tenant so the chain has a single, gap-free order.
  PERFORM pg_advisory_xact_lock(hashtextextended('audit:' || NEW.tenant_id::text, 0));
  SELECT e.seq, e.hash INTO last_seq, last_hash
    FROM audit_events e WHERE e.tenant_id = NEW.tenant_id ORDER BY e.seq DESC LIMIT 1;
  NEW.seq := COALESCE(last_seq, 0) + 1;
  NEW.prev_hash := COALESCE(last_hash, repeat('0', 64));
  NEW.occurred_at := clock_timestamp();
  NEW.hash := audit_hash(NEW.prev_hash, NEW.tenant_id, NEW.seq, NEW.occurred_at, NEW.actor_type::text,
    NEW.actor_id, NEW.actor_label, NEW.action, NEW.entity_type, NEW.entity_id, NEW.request_ref,
    NEW.summary, NEW.before, NEW.after);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_events_chain BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_chain();
--> statement-breakpoint

CREATE FUNCTION audit_events_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_events_no_update_delete BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();
--> statement-breakpoint

-- Recomputes the whole chain for the current tenant. Returns (true, NULL) when intact,
-- otherwise (false, <first broken seq>).
CREATE FUNCTION verify_audit_chain(p_tenant uuid, OUT ok boolean, OUT broken_seq bigint, OUT checked bigint)
  LANGUAGE plpgsql STABLE
  AS $$
DECLARE
  r record;
  expected_prev text := repeat('0', 64);
  expected_seq bigint := 1;
BEGIN
  ok := true; broken_seq := NULL; checked := 0;
  FOR r IN SELECT * FROM audit_events WHERE tenant_id = p_tenant ORDER BY seq LOOP
    IF r.seq <> expected_seq OR r.prev_hash <> expected_prev OR r.hash <> audit_hash(
         r.prev_hash, r.tenant_id, r.seq, r.occurred_at, r.actor_type::text, r.actor_id, r.actor_label,
         r.action, r.entity_type, r.entity_id, r.request_ref, r.summary, r.before, r.after) THEN
      ok := false; broken_seq := r.seq; RETURN;
    END IF;
    expected_prev := r.hash; expected_seq := expected_seq + 1; checked := checked + 1;
  END LOOP;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 4. Login resolution. Before a tenant is known the app cannot read `users` through RLS, so two
--    narrow SECURITY DEFINER functions (running as the owner) expose only what login needs.
-- ---------------------------------------------------------------------------------------------
CREATE POLICY auth_lookup ON users FOR SELECT TO taxops_owner USING (true);
--> statement-breakpoint
CREATE POLICY auth_lookup ON tenants FOR SELECT TO taxops_owner USING (true);
--> statement-breakpoint

CREATE FUNCTION auth_resolve_user(p_email text)
  RETURNS TABLE (user_id uuid, tenant_id uuid, role role, is_active boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT u.id, u.tenant_id, u.role, u.is_active FROM users u WHERE lower(u.email) = lower(p_email) $$;
--> statement-breakpoint

-- Development sign-in picker. Refuses to run unless the app explicitly enabled dev login for
-- this transaction (the app only does so when AUTH_MODE=dev and NODE_ENV is not production).
CREATE FUNCTION auth_dev_list_users(p_slug text)
  RETURNS TABLE (user_id uuid, name text, email text, title text, role role)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  IF coalesce(current_setting('app.allow_dev_login', true), '') <> 'on' THEN
    RAISE EXCEPTION 'dev login is disabled' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT u.id, u.name, u.email, u.title, u.role
    FROM users u JOIN tenants t ON t.id = u.tenant_id
    WHERE t.slug = p_slug AND u.is_active ORDER BY u.role, u.name;
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_resolve_user(text), auth_dev_list_users(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_resolve_user(text), auth_dev_list_users(text) TO taxops_app;
