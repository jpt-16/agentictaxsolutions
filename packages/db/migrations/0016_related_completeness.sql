-- Reconciliation must know when it was NOT shown a whole trial balance (rows are capped), so it never reports "amount not in the books"
-- for an account beyond the cut-off. Also caps the number of documents/trial balances per call at 25 to bound memory.
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
    'tenant', (SELECT jsonb_build_object('external_llm_enabled', t.external_llm_enabled) FROM tenants t WHERE t.id = j.tenant_id),
    'proposals', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
          'id', q.id, 'schema_key', q.schema_key, 'payload', q.payload, 'file_name', q.file_name, 'item_title', q.item_title,
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
