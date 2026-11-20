-- Security for AI agent output: tenant RLS, least-privilege grants, immutable decisions, and the worker's
-- only door into the data (two SECURITY DEFINER functions that derive the tenant from the job being worked).

ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON agent_runs USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE proposals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON proposals USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
ALTER TABLE extracted_rows ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE extracted_rows FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON extracted_rows USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint

-- The app can READ agent output and record a human decision. It can never create proposals or rows
-- (only the worker functions below can), and it can only touch the four decision columns.
GRANT SELECT ON agent_runs, extracted_rows TO taxops_app;
--> statement-breakpoint
GRANT SELECT ON proposals TO taxops_app;
--> statement-breakpoint
GRANT UPDATE (status, decided_by, decided_at, decision_note) ON proposals TO taxops_app;
--> statement-breakpoint

-- Decisions are final and tightly shaped. The app role may only move pending -> accepted/rejected, must name
-- the decider, and cannot alter any other column; the owner (used by the worker functions) may only mark a pending
-- proposal superseded when the agent re-runs.
CREATE FUNCTION proposals_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (OLD.id, OLD.tenant_id, OLD.run_id, OLD.file_id, OLD.request_id, OLD.item_id, OLD.kind, OLD.schema_key, OLD.title,
      OLD.detail, OLD.payload, OLD.confidence, OLD.severity, OLD.created_at)
     IS DISTINCT FROM
     (NEW.id, NEW.tenant_id, NEW.run_id, NEW.file_id, NEW.request_id, NEW.item_id, NEW.kind, NEW.schema_key, NEW.title,
      NEW.detail, NEW.payload, NEW.confidence, NEW.severity, NEW.created_at) THEN
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
CREATE TRIGGER proposals_guard BEFORE UPDATE ON proposals FOR EACH ROW EXECUTE FUNCTION proposals_guard();
--> statement-breakpoint

-- Returns the file a RUNNING job (held by this worker) refers to, plus the tenant's data-governance flags.
-- The worker cannot ask for arbitrary files: access is bound to the job it currently holds.
CREATE FUNCTION agent_get_file(p_job_id uuid, p_worker text)
  RETURNS TABLE (tenant_id uuid, file_id uuid, request_id uuid, item_id uuid, submission_id uuid, storage_key text,
                 sha256 text, original_name text, content_type text, size_bytes bigint,
                 ai_extraction_enabled boolean, external_llm_enabled boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  j jobs%ROWTYPE;
BEGIN
  SELECT * INTO j FROM jobs WHERE id = p_job_id AND status = 'running' AND locked_by = p_worker;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job is not held by this worker' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.tenant_id', j.tenant_id::text, true);
  RETURN QUERY
    SELECT f.tenant_id, f.id, rq.id, it.id, s.id, f.storage_key, f.sha256, f.original_name, f.content_type, f.size_bytes,
           t.ai_extraction_enabled, t.external_llm_enabled
      FROM files f
      JOIN submissions s ON s.tenant_id = f.tenant_id AND s.id = f.submission_id
      JOIN request_items it ON it.tenant_id = s.tenant_id AND it.id = s.item_id
      JOIN requests rq ON rq.tenant_id = it.tenant_id AND rq.id = it.request_id
      JOIN tenants t ON t.id = f.tenant_id
     WHERE f.id = (j.payload ->> 'fileId')::uuid;
END $$;
--> statement-breakpoint

-- Records an agent run with its proposals and standardized rows, atomically, plus audit events (actor = the agent).
-- Idempotent per (job, agent): a retried job returns the original proposal ids instead of duplicating output.
-- Tenant, file, request and item all come from the job, never from the caller.
CREATE FUNCTION agent_save_results(p_job_id uuid, p_worker text, p_agent_name text, p_agent_version text,
                                   p_run jsonb, p_proposals jsonb, p_rows jsonb)
  RETURNS uuid[]
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  j jobs%ROWTYPE;
  v_file uuid; v_req uuid; v_item uuid; v_run uuid;
  v_ids uuid[] := ARRAY[]::uuid[];
  v_id uuid; p jsonb; v_label text; v_idx int := 0;
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
    -- A re-run replaces earlier pending output for the same sheet; decided proposals are never touched.
    UPDATE proposals SET status = 'superseded'
     WHERE file_id = v_file AND status = 'pending' AND kind = (p ->> 'kind')::proposal_kind
       AND schema_key IS NOT DISTINCT FROM (p ->> 'schema_key') AND (payload ->> 'sheet') IS NOT DISTINCT FROM (p -> 'payload' ->> 'sheet');
    INSERT INTO proposals (tenant_id, run_id, file_id, request_id, item_id, kind, schema_key, title, detail, payload, confidence, severity)
    VALUES (j.tenant_id, v_run, v_file, v_req, v_item, (p ->> 'kind')::proposal_kind, p ->> 'schema_key', left(p ->> 'title', 300),
            left(coalesce(p ->> 'detail', ''), 2000), p -> 'payload', (p ->> 'confidence')::numeric, (p ->> 'severity')::severity)
    RETURNING id INTO v_id;
    v_ids := v_ids || v_id;
  END LOOP;

  INSERT INTO extracted_rows (tenant_id, proposal_id, position, sheet, source_row, values, cells, issues)
  SELECT j.tenant_id, v_ids[(r.value ->> 'proposal_index')::int + 1], r.ord::int, left(r.value ->> 'sheet', 200),
         (r.value ->> 'source_row')::int, r.value -> 'values', r.value -> 'cells', coalesce(r.value -> 'issues', '[]'::jsonb)
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS r(value, ord);

  FOREACH v_id IN ARRAY v_ids LOOP
    v_idx := v_idx + 1;
    INSERT INTO audit_events (tenant_id, seq, actor_type, actor_id, actor_label, action, entity_type, entity_id, request_ref, summary, before, after, prev_hash, hash)
    SELECT j.tenant_id, 0, 'agent', NULL, v_label, 'proposal.created', 'proposal', v_id, v_req,
           'Proposed "' || pr.title || '" for review', NULL,
           jsonb_build_object('kind', pr.kind, 'confidence', pr.confidence, 'severity', pr.severity, 'file_id', v_file,
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

REVOKE ALL ON FUNCTION agent_get_file(uuid, text), agent_save_results(uuid, text, text, text, jsonb, jsonb, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION agent_get_file(uuid, text), agent_save_results(uuid, text, text, text, jsonb, jsonb, jsonb) TO taxops_worker;
