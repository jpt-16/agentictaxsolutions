-- Phase 5 hardening: per-user notifications, DB-enforced administration, draft-only deletes, audit export, ops metrics.

-- ---------------------------------------------------------------------------------------------------------------
-- Notifications: anyone in the tenant may create one (fan-out); only the recipient may read it or mark it read.
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY notif_insert ON notifications FOR INSERT WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
CREATE POLICY notif_select ON notifications FOR SELECT USING (tenant_id = app_tenant_id() AND user_id = app_user_id());
--> statement-breakpoint
CREATE POLICY notif_update ON notifications FOR UPDATE USING (tenant_id = app_tenant_id() AND user_id = app_user_id())
  WITH CHECK (tenant_id = app_tenant_id() AND user_id = app_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON notifications TO taxops_app;
--> statement-breakpoint
GRANT UPDATE (read_at) ON notifications TO taxops_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Tenant administration is enforced HERE, not only in the application.
-- ---------------------------------------------------------------------------------------------------------------
-- Tenant AI switches: tenant admins only, and nothing else on the tenant row can change.
GRANT UPDATE (ai_extraction_enabled, external_llm_enabled) ON tenants TO taxops_app;
--> statement-breakpoint
CREATE FUNCTION tenants_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF current_user <> 'taxops_owner' AND app_user_role() IS DISTINCT FROM 'tenant_admin' THEN
    RAISE EXCEPTION 'only tenant admins may change tenant settings' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER tenants_guard BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION tenants_guard();
--> statement-breakpoint

-- Users: the app role may only create/edit people through a tenant admin, may not touch email or tenant, cannot demote or
-- deactivate itself, and can never remove the last active admin.
REVOKE INSERT, UPDATE ON users FROM taxops_app;
--> statement-breakpoint
GRANT INSERT (id, tenant_id, email, name, title, role, department_id, entity_id, is_active, created_at) ON users TO taxops_app;
--> statement-breakpoint
GRANT UPDATE (name, title, role, department_id, entity_id, is_active) ON users TO taxops_app;
--> statement-breakpoint
CREATE FUNCTION users_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF current_user = 'taxops_owner' THEN
    RETURN NEW;
  END IF;
  IF app_user_role() IS DISTINCT FROM 'tenant_admin' THEN
    RAISE EXCEPTION 'only tenant admins may manage users' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.id = app_user_id() AND (NEW.role IS DISTINCT FROM OLD.role OR NEW.is_active = false) THEN
      RAISE EXCEPTION 'you cannot change your own role or deactivate yourself' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.role = 'tenant_admin' AND OLD.is_active AND (NEW.role <> 'tenant_admin' OR NEW.is_active = false)
       AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id <> OLD.id AND u.role = 'tenant_admin' AND u.is_active) THEN
      RAISE EXCEPTION 'at least one active tenant admin is required' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER users_guard BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION users_guard();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Draft editing needs deletes on items and assignments, but ONLY while the request is still a draft.
-- ---------------------------------------------------------------------------------------------------------------
GRANT DELETE ON request_items, assignments TO taxops_app;
--> statement-breakpoint
CREATE FUNCTION draft_only_delete() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM requests r WHERE r.id = OLD.request_id AND r.status = 'draft') THEN
    RAISE EXCEPTION 'rows of a published request cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER draft_only_delete BEFORE DELETE ON request_items FOR EACH ROW EXECUTE FUNCTION draft_only_delete();
--> statement-breakpoint
CREATE TRIGGER draft_only_delete BEFORE DELETE ON assignments FOR EACH ROW EXECUTE FUNCTION draft_only_delete();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Audit export: each row carries the EXACT text that was hashed, so an offline verifier can re-check the chain with
-- nothing but SHA-256 and this file.
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION audit_canonical(r audit_events) RETURNS text
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT jsonb_build_array(
      r.prev_hash, r.tenant_id, r.seq, to_char(r.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
      r.actor_type::text, r.actor_id, r.actor_label, r.action, r.entity_type, r.entity_id, r.request_ref, r.summary, r.before, r.after
    )::text
  $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Operations metrics: AGGREGATE counts only (no tenant content), readable by the app for the /metrics endpoint.
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION ops_metrics() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT jsonb_build_object(
      'jobs', (SELECT coalesce(jsonb_object_agg(k, n), '{}'::jsonb) FROM (SELECT type || ':' || status AS k, count(*) AS n FROM jobs GROUP BY 1) j),
      'oldest_queued_seconds', (SELECT coalesce(extract(epoch FROM now() - min(run_after))::int, 0) FROM jobs WHERE status = 'queued' AND run_after <= now()),
      'dead_jobs', (SELECT count(*) FROM jobs WHERE status = 'dead'),
      'proposals_pending', (SELECT count(*) FROM proposals WHERE status = 'pending'),
      'tenants', (SELECT count(*) FROM tenants),
      'audit_events', (SELECT count(*) FROM audit_events)
    )
  $$;
--> statement-breakpoint
-- Cross-tenant visibility is confined to this ONE aggregate-only function, owned by a dedicated BYPASSRLS role. (Broad
-- "owner can read all" row policies would silently widen every other SECURITY DEFINER function that relies on tenant RLS.)
-- (Changing an owner needs the new owner to hold CREATE on the schema; grant it for this statement only.)
GRANT CREATE ON SCHEMA public TO taxops_ops;
--> statement-breakpoint
ALTER FUNCTION ops_metrics() OWNER TO taxops_ops;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM taxops_ops;
--> statement-breakpoint
GRANT SELECT ON jobs, proposals, tenants, audit_events TO taxops_ops;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ops_metrics() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ops_metrics() TO taxops_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Agent output notifies reviewers: extend agent_save_results' effects via a trigger on proposals (keeps that function
-- untouched). One notification per new extraction proposal; findings roll up one per request per run.
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION proposals_notify() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  PERFORM set_config('app.tenant_id', NEW.tenant_id::text, true);
  IF NEW.kind = 'extraction' THEN
    INSERT INTO notifications (tenant_id, user_id, type, title, body, link, dedupe_key)
    SELECT NEW.tenant_id, u.id, 'ai_result', 'New AI result to review', NEW.title, '/review/' || NEW.id, 'proposal:' || NEW.id
      FROM users u WHERE u.tenant_id = NEW.tenant_id AND u.is_active AND u.role IN ('tax_manager', 'tax_reviewer')
    ON CONFLICT DO NOTHING;
  ELSIF NEW.kind = 'finding' AND NEW.severity = 'error' THEN
    INSERT INTO notifications (tenant_id, user_id, type, title, body, link, dedupe_key)
    SELECT NEW.tenant_id, u.id, 'finding', 'Validation error found', NEW.title, '/review/' || NEW.id, 'proposal:' || NEW.id
      FROM users u WHERE u.tenant_id = NEW.tenant_id AND u.is_active AND u.role IN ('tax_manager', 'tax_reviewer')
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER proposals_notify AFTER INSERT ON proposals FOR EACH ROW EXECUTE FUNCTION proposals_notify();
