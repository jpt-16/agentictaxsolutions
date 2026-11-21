-- Request templates: tenant-isolated; the app may read, create, and archive (set archived_at). No UPDATE of content, no DELETE.
ALTER TABLE request_templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE request_templates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tmpl_select ON request_templates FOR SELECT USING (tenant_id = app_tenant_id());
--> statement-breakpoint
CREATE POLICY tmpl_insert ON request_templates FOR INSERT WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
CREATE POLICY tmpl_update ON request_templates FOR UPDATE USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON request_templates TO taxops_app;
--> statement-breakpoint
GRANT UPDATE (archived_at) ON request_templates TO taxops_app;
--> statement-breakpoint
-- Only people who may create requests may create or archive templates (defence in depth; the app checks too).
CREATE OR REPLACE FUNCTION request_templates_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'taxops_app' AND app_user_role() IS DISTINCT FROM 'tax_manager' THEN
    RAISE EXCEPTION 'only a tax manager may manage request templates' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER request_templates_guard BEFORE INSERT OR UPDATE ON request_templates FOR EACH ROW EXECUTE FUNCTION request_templates_guard();
