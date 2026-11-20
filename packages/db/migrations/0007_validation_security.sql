-- Phase 4: validation findings. Identity helpers for DB-enforced role checks, rule settings, and the worker functions
-- extended for findings (which always hang off an ACCEPTED extraction).

CREATE FUNCTION app_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
-- The acting user's role, looked up from the data (never trusted from the client). NULL when no user is set.
CREATE FUNCTION app_user_role() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT u.role::text FROM users u WHERE u.id = app_user_id() AND u.is_active $$;
--> statement-breakpoint

ALTER TABLE rule_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE rule_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON rule_settings USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON rule_settings TO taxops_app;
--> statement-breakpoint
CREATE FUNCTION rule_settings_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF app_user_role() IS NULL OR app_user_role() NOT IN ('tax_manager', 'tenant_admin') THEN
    RAISE EXCEPTION 'only tax managers and tenant admins may change validation rules' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_by := app_user_id();
  NEW.updated_at := now();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER rule_settings_guard BEFORE INSERT OR UPDATE ON rule_settings FOR EACH ROW EXECUTE FUNCTION rule_settings_guard();
--> statement-breakpoint

-- The immutability check now also covers the finding link columns.
CREATE OR REPLACE FUNCTION proposals_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (OLD.id, OLD.tenant_id, OLD.run_id, OLD.file_id, OLD.request_id, OLD.item_id, OLD.kind, OLD.schema_key, OLD.source_proposal_id,
      OLD.rule_id, OLD.title, OLD.detail, OLD.payload, OLD.confidence, OLD.severity, OLD.created_at)
     IS DISTINCT FROM
     (NEW.id, NEW.tenant_id, NEW.run_id, NEW.file_id, NEW.request_id, NEW.item_id, NEW.kind, NEW.schema_key, NEW.source_proposal_id,
      NEW.rule_id, NEW.title, NEW.detail, NEW.payload, NEW.confidence, NEW.severity, NEW.created_at) THEN
    RAISE EXCEPTION 'proposal content is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'proposal decision is final (already %)', OLD.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF current_user = 'taxops_owner' THEN
    IF NEW.status <> 'superseded' THEN
      RAISE EXCEPTION 'agents may only supersede proposals' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    IF NEW.status NOT IN ('accepted', 'rejected') OR NEW.decided_by IS NULL OR NEW.decided_at IS NULL THEN
      RAISE EXCEPTION 'a decision must be accepted or rejected, with a decider and time' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.status = 'rejected' AND length(btrim(coalesce(NEW.decision_note, ''))) < 3 THEN
      RAISE EXCEPTION 'rejecting a proposal requires a reason' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- Everything a validation run may read, bound to the job it holds: the ACCEPTED extraction it was triggered by, that
-- extraction's rows, the tenant's rule settings and the one governance flag that matters for explanations.
CREATE FUNCTION agent_get_proposal(p_job_id uuid, p_worker text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  j jobs%ROWTYPE;
  pr proposals%ROWTYPE;
BEGIN
  SELECT * INTO j FROM jobs WHERE id = p_job_id AND status = 'running' AND locked_by = p_worker;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job is not held by this worker' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.tenant_id', j.tenant_id::text, true);
  SELECT * INTO pr FROM proposals WHERE id = (j.payload ->> 'proposalId')::uuid AND kind = 'extraction' AND status = 'accepted';
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'proposal', jsonb_build_object('id', pr.id, 'schema_key', pr.schema_key, 'payload', pr.payload, 'file_id', pr.file_id,
                                   'request_id', pr.request_id, 'item_id', pr.item_id),
    'rows', (SELECT coalesce(jsonb_agg(jsonb_build_object('position', e.position, 'sheet', e.sheet, 'source_row', e.source_row,
                                                          'values', e.values, 'cells', e.cells, 'issues', e.issues) ORDER BY e.position), '[]'::jsonb)
               FROM extracted_rows e WHERE e.proposal_id = pr.id),
    'settings', (SELECT coalesce(jsonb_agg(jsonb_build_object('rule_id', s.rule_id, 'enabled', s.enabled, 'params', s.params)), '[]'::jsonb) FROM rule_settings s),
    'tenant', (SELECT jsonb_build_object('external_llm_enabled', t.external_llm_enabled) FROM tenants t WHERE t.id = j.tenant_id),
    'request', (SELECT jsonb_build_object('id', r.id, 'reference', r.reference, 'tax_year', r.tax_year) FROM requests r WHERE r.id = pr.request_id)
  );
END $$;
--> statement-breakpoint

-- agent_save_results, now finding-aware. A finding must name the job's own accepted extraction as its source, so a worker
-- cannot attach findings to anything it was not asked about. Findings supersede earlier PENDING findings of the same rule
-- and key for that source; decided ones are never touched.
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
    UPDATE proposals SET status = 'superseded'
     WHERE source_proposal_id = (j.payload ->> 'proposalId')::uuid AND kind = 'finding' AND status = 'pending' AND id <> ALL (v_ids);
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

REVOKE ALL ON FUNCTION agent_get_proposal(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION agent_get_proposal(uuid, text) TO taxops_worker;
