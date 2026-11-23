-- Which legal entity each trial balance belongs to. A person's decision (never an agent's), settable only while the result is pending,
-- frozen once it is decided. Reconciliation reads it through agent_get_related so it can compare one entity's books with another's.
ALTER TABLE proposal_entities ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE proposal_entities FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON proposal_entities USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON proposal_entities TO taxops_app;
--> statement-breakpoint
GRANT UPDATE (entity_id, source, set_by, set_at) ON proposal_entities TO taxops_app;
--> statement-breakpoint
CREATE FUNCTION proposal_entities_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF app_user_role() IS NULL OR app_user_role() NOT IN ('tax_manager', 'tax_reviewer') THEN
    RAISE EXCEPTION 'only reviewers may set the entity of a result' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM proposals p WHERE p.id = NEW.proposal_id AND p.status = 'pending' AND p.kind = 'extraction') THEN
    RAISE EXCEPTION 'the entity can only be set while an extraction result is pending' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.set_by := app_user_id();
  NEW.set_at := now();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER proposal_entities_guard BEFORE INSERT OR UPDATE ON proposal_entities FOR EACH ROW EXECUTE FUNCTION proposal_entities_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_get_related(p_job_id uuid, p_worker text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  j jobs%ROWTYPE;
  me proposals%ROWTYPE;
BEGIN
  SELECT * INTO j FROM jobs WHERE id = p_job_id AND status = 'running' AND locked_by = p_worker;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job is not held by this worker' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.tenant_id', j.tenant_id::text, true);
  SELECT * INTO me FROM proposals WHERE id = (j.payload ->> 'proposalId')::uuid AND kind = 'extraction' AND status = 'accepted';
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'self', me.id,
    'request', (SELECT jsonb_build_object('id', r.id, 'reference', r.reference, 'tax_year', r.tax_year) FROM requests r WHERE r.id = me.request_id),
    'settings', (SELECT coalesce(jsonb_agg(jsonb_build_object('rule_id', s.rule_id, 'enabled', s.enabled, 'params', s.params)), '[]'::jsonb) FROM rule_settings s),
    'entities', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'code', e.code, 'name', e.name) ORDER BY e.code), '[]'::jsonb) FROM legal_entities e),
    'tenant', (SELECT jsonb_build_object('external_llm_enabled', t.external_llm_enabled) FROM tenants t WHERE t.id = j.tenant_id),
    'proposals', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
          'id', q.id, 'schema_key', q.schema_key, 'payload', q.payload, 'file_name', q.file_name, 'item_title', q.item_title,
          'entity', (SELECT jsonb_build_object('id', e.id, 'code', e.code, 'name', e.name, 'source', pe.source)
                       FROM proposal_entities pe JOIN legal_entities e ON e.tenant_id = pe.tenant_id AND e.id = pe.entity_id
                      WHERE pe.proposal_id = q.id),
          'row_total', CASE WHEN q.schema_key = 'trial_balance' THEN (SELECT count(*) FROM extracted_rows c WHERE c.proposal_id = q.id) ELSE 0 END,
          'rows', CASE WHEN q.schema_key = 'trial_balance' THEN
                    (SELECT coalesce(jsonb_agg(jsonb_build_object('position', e.position, 'sheet', e.sheet, 'source_row', e.source_row,
                                                                  'values', e.values, 'cells', e.cells, 'issues', e.issues) ORDER BY e.position), '[]'::jsonb)
                       FROM (SELECT * FROM extracted_rows x WHERE x.proposal_id = q.id ORDER BY x.position LIMIT 5000) e)
                  ELSE '[]'::jsonb END) ORDER BY q.created_at), '[]'::jsonb)
        FROM (SELECT p.id, p.schema_key, p.payload, p.created_at, f.original_name AS file_name, it.title AS item_title
                FROM proposals p
                JOIN files f ON f.tenant_id = p.tenant_id AND f.id = p.file_id
                JOIN request_items it ON it.tenant_id = p.tenant_id AND it.id = p.item_id
               WHERE p.request_id = me.request_id AND p.kind = 'extraction' AND p.status = 'accepted'
                 AND p.schema_key IN ('trial_balance', 'supporting_document')
               ORDER BY p.created_at LIMIT 25) q)
  );
END $$;
