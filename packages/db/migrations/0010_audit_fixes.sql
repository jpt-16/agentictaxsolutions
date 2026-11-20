-- Audit fixes. #1: the app role could rewrite evidence (reviews, submissions, comments) and identifying fields (request
-- references, creators, entity names) without an audit trail. Write access is now exactly the columns the code changes.

REVOKE UPDATE ON reviews, submissions, comments, assignments, departments, legal_entities, requests, request_items, rule_settings FROM taxops_app;
--> statement-breakpoint
-- Status transitions (publish, close, derived status) and draft edits. Never reference, created_by, tenant_id or created_at.
GRANT UPDATE (status, published_at, closed_at, updated_at, title, description, tax_year, due_date, priority) ON requests TO taxops_app;
--> statement-breakpoint
-- Item workflow status only. Draft edits replace items (delete + insert), which a trigger allows only for drafts.
GRANT UPDATE (status, updated_at) ON request_items TO taxops_app;
--> statement-breakpoint
-- Rule toggles and parameters; updated_by/updated_at are set by the guard trigger, not the caller.
GRANT UPDATE (enabled, params) ON rule_settings TO taxops_app;
--> statement-breakpoint
-- Draft title/description/etc. may change only while the request is a draft; status columns follow the workflow.
CREATE FUNCTION requests_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF current_user <> 'taxops_owner' AND OLD.status <> 'draft'
     AND (NEW.title, NEW.description, NEW.tax_year, NEW.due_date, NEW.priority) IS DISTINCT FROM (OLD.title, OLD.description, OLD.tax_year, OLD.due_date, OLD.priority) THEN
    RAISE EXCEPTION 'a published request cannot be edited' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER requests_guard BEFORE UPDATE ON requests FOR EACH ROW EXECUTE FUNCTION requests_guard();
--> statement-breakpoint

-- #15: the notification trigger switched the transaction's tenant setting as a side effect. Restore it afterwards.
CREATE OR REPLACE FUNCTION proposals_notify() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  prev text := current_setting('app.tenant_id', true);
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
  PERFORM set_config('app.tenant_id', coalesce(prev, ''), true);
  RETURN NEW;
END $$;
