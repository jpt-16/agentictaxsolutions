-- Spending limit for external model calls.
ALTER TABLE tenants ADD CONSTRAINT tenants_llm_daily_call_limit_range CHECK (llm_daily_call_limit BETWEEN 0 AND 100000);
--> statement-breakpoint
-- Only a tenant admin may change it (tenants_guard already restricts UPDATE on tenants to admins); the app role gets this one column.
GRANT UPDATE (llm_daily_call_limit) ON tenants TO taxops_app;
--> statement-breakpoint
-- What the worker may know about the budget: the company's limit and the calls it has made in the last 24 hours. Bound to the job
-- the worker holds, like every other worker function, and it returns two numbers, nothing else.
CREATE FUNCTION agent_llm_budget(p_job_id uuid, p_worker text) RETURNS jsonb
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
  RETURN jsonb_build_object(
    'limit', (SELECT t.llm_daily_call_limit FROM tenants t WHERE t.id = j.tenant_id),
    'used', (SELECT coalesce(sum(r.llm_calls), 0)::int FROM agent_runs r WHERE r.created_at > now() - interval '24 hours')
  );
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION agent_llm_budget(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION agent_llm_budget(uuid, text) TO taxops_worker;
