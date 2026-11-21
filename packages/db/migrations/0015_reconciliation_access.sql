-- 1) Retiring "findings this run did not raise again" must only touch the SAME agent's findings. Without this, a second agent
--    working on the same accepted proposal would retire the first agent's open findings.
CREATE OR REPLACE FUNCTION agent_save_results(p_job_id uuid, p_worker text, p_agent_name text, p_agent_version text,
                                              p_run jsonb, p_proposals jsonb, p_rows jsonb)
  RETURNS uuid[]
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  j jobs%ROWTYPE;
  v_file uuid; v_req uuid; v_item uuid; v_run uuid;
  v_ids uuid[] := ARRAY[]::uuid[];
  v_id uuid; p jsonb; v_label text; v_idx int := 0;
  v_source uuid; v_kind proposal_kind;
BEGIN
  SELECT * INTO j FROM jobs WHERE id = p_job_id AND status = 'running' AND locked_by = p_worker;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job is not held by this worker' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF jsonb_array_length(p_proposals) > 200 OR jsonb_array_length(p_rows) > 20000 THEN
    RAISE EXCEPTION 'agent output exceeds allowed size' USING ERRCODE = 'program_limit_exceeded';
  END IF;
  PERFORM set_config('app.tenant_id', j.tenant_id::text, true);

  SELECT f.id, rq.id, it.id INTO v_file, v_req, v_item
    FROM files f
    JOIN submissions s ON s.tenant_id = f.tenant_id AND s.id = f.submission_id
    JOIN request_items it ON it.tenant_id = s.tenant_id AND it.id = s.item_id
    JOIN requests rq ON rq.tenant_id = it.tenant_id AND rq.id = it.request_id
   WHERE f.id = (j.payload ->> 'fileId')::uuid;
  IF v_file IS NULL THEN
    RAISE EXCEPTION 'file for job not found' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT id INTO v_run FROM agent_runs WHERE job_id = p_job_id AND agent_name = p_agent_name;
  IF v_run IS NOT NULL THEN
    RETURN coalesce((SELECT array_agg(id ORDER BY created_at, id) FROM proposals WHERE run_id = v_run), ARRAY[]::uuid[]);
  END IF;

  v_label := initcap(replace(p_agent_name, '_', ' ')) || ' v' || p_agent_version;
  INSERT INTO agent_runs (tenant_id, job_id, agent_name, agent_version, event, file_id, status, detail, model, prompt_version, llm_calls, duration_ms)
  VALUES (j.tenant_id, p_job_id, p_agent_name, p_agent_version, j.type, v_file, (p_run ->> 'status')::run_status,
          left(coalesce(p_run ->> 'detail', ''), 2000), left(p_run ->> 'model', 100), left(p_run ->> 'prompt_version', 100),
          coalesce((p_run ->> 'llm_calls')::int, 0), coalesce((p_run ->> 'duration_ms')::int, 0))
  RETURNING id INTO v_run;

  FOR p IN SELECT * FROM jsonb_array_elements(p_proposals) LOOP
    v_kind := (p ->> 'kind')::proposal_kind;
    v_source := nullif(p ->> 'source_proposal_id', '')::uuid;
    IF v_kind = 'finding' THEN
      IF v_source IS NULL OR v_source IS DISTINCT FROM (j.payload ->> 'proposalId')::uuid THEN
        RAISE EXCEPTION 'a finding must reference the proposal its job was created for' USING ERRCODE = 'insufficient_privilege';
      END IF;
      UPDATE proposals SET status = 'superseded'
       WHERE source_proposal_id = v_source AND status = 'pending' AND kind = 'finding'
         AND rule_id IS NOT DISTINCT FROM (p ->> 'rule_id') AND (payload ->> 'dedupe') IS NOT DISTINCT FROM (p -> 'payload' ->> 'dedupe');
    ELSE
      v_source := NULL;
      UPDATE proposals SET status = 'superseded'
       WHERE file_id = v_file AND status = 'pending' AND kind = v_kind
         AND schema_key IS NOT DISTINCT FROM (p ->> 'schema_key') AND (payload ->> 'sheet') IS NOT DISTINCT FROM (p -> 'payload' ->> 'sheet');
    END IF;
    INSERT INTO proposals (tenant_id, run_id, file_id, request_id, item_id, kind, schema_key, source_proposal_id, rule_id, title, detail, payload, confidence, severity)
    VALUES (j.tenant_id, v_run, v_file, v_req, v_item, v_kind, p ->> 'schema_key', v_source, p ->> 'rule_id', left(p ->> 'title', 300),
            left(coalesce(p ->> 'detail', ''), 2000), p -> 'payload', (p ->> 'confidence')::numeric, (p ->> 'severity')::severity)
    RETURNING id INTO v_id;
    v_ids := v_ids || v_id;
  END LOOP;

  -- A validation re-run is authoritative for its source: pending findings it did NOT raise again (data fixed, rule switched
  -- off) are retired. Decided findings are never touched.
  IF j.payload ? 'proposalId' THEN
    -- Scoped to THIS agent's own earlier findings: another agent (e.g. reconciliation) may have findings on the same source.
    UPDATE proposals SET status = 'superseded'
     WHERE source_proposal_id = (j.payload ->> 'proposalId')::uuid AND kind = 'finding' AND status = 'pending' AND id <> ALL (v_ids)
       AND run_id IN (SELECT ar.id FROM agent_runs ar WHERE ar.agent_name = p_agent_name);
  END IF;

  INSERT INTO extracted_rows (tenant_id, proposal_id, position, sheet, source_row, values, cells, issues)
  SELECT j.tenant_id, v_ids[(r.value ->> 'proposal_index')::int + 1], r.ord::int, left(r.value ->> 'sheet', 200),
         (r.value ->> 'source_row')::int, r.value -> 'values', r.value -> 'cells', coalesce(r.value -> 'issues', '[]'::jsonb)
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS r(value, ord);

  FOREACH v_id IN ARRAY v_ids LOOP
    v_idx := v_idx + 1;
    INSERT INTO audit_events (tenant_id, seq, actor_type, actor_id, actor_label, action, entity_type, entity_id, request_ref, summary, before, after, prev_hash, hash)
    SELECT j.tenant_id, 0, 'agent', NULL, v_label, 'proposal.created', 'proposal', v_id, v_req,
           CASE pr.kind WHEN 'finding' THEN 'Raised finding "' ELSE 'Proposed "' END || pr.title || CASE pr.kind WHEN 'finding' THEN '"' ELSE '" for review' END, NULL,
           jsonb_build_object('kind', pr.kind, 'confidence', pr.confidence, 'severity', pr.severity, 'file_id', v_file, 'rule_id', pr.rule_id,
                              'rows', (SELECT count(*) FROM extracted_rows WHERE proposal_id = pr.id)), '', ''
      FROM proposals pr WHERE pr.id = v_id;
  END LOOP;
  INSERT INTO audit_events (tenant_id, seq, actor_type, actor_id, actor_label, action, entity_type, entity_id, request_ref, summary, before, after, prev_hash, hash)
  VALUES (j.tenant_id, 0, 'agent', NULL, v_label, 'agent.run_' || (p_run ->> 'status'), 'file', v_file, v_req,
          CASE p_run ->> 'status' WHEN 'skipped' THEN 'Skipped file: ' ELSE 'Processed file: ' END || left(coalesce(p_run ->> 'detail', ''), 300), NULL,
          jsonb_build_object('proposals', coalesce(array_length(v_ids, 1), 0), 'llm_calls', coalesce((p_run ->> 'llm_calls')::int, 0), 'model', p_run ->> 'model'), '', '');
  RETURN v_ids;
END $$;
--> statement-breakpoint

-- 2) Cross-file read for reconciliation. Bound to the job the worker holds: it returns only ACCEPTED extractions that belong to the
--    SAME request as the job's own accepted proposal (never another request or tenant), capped in size, and nothing else.
CREATE FUNCTION agent_get_related(p_job_id uuid, p_worker text) RETURNS jsonb
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
               ORDER BY p.created_at LIMIT 50) q)
  );
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION agent_get_related(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION agent_get_related(uuid, text) TO taxops_worker;
