-- Security for files + jobs: tenant RLS, least-privilege grants, and the worker's narrow queue interface.

ALTER TABLE files ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE files FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON files USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
-- Files are immutable once stored: the app may add and read them, never alter or remove them.
GRANT SELECT, INSERT ON files TO taxops_app;
--> statement-breakpoint

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON jobs USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
-- The queue functions below run as the owner and must see jobs across tenants.
CREATE POLICY worker_queue ON jobs TO taxops_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, INSERT ON jobs TO taxops_app;
--> statement-breakpoint

-- Claims up to p_limit runnable jobs (FOR UPDATE SKIP LOCKED, so workers never collide). Jobs whose lease has
-- expired (worker crashed) become claimable again; ones that already used all attempts are marked dead instead.
CREATE FUNCTION jobs_claim(p_worker text, p_types text[], p_limit int DEFAULT 1, p_lease_seconds int DEFAULT 600)
  RETURNS TABLE (id uuid, tenant_id uuid, type text, payload jsonb, attempts int)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  UPDATE jobs j SET status = 'dead', last_error = coalesce(j.last_error, 'lease expired after final attempt'),
         locked_by = NULL, locked_at = NULL, updated_at = now()
   WHERE j.status = 'running' AND j.locked_at < now() - make_interval(secs => p_lease_seconds) AND j.attempts >= j.max_attempts;

  RETURN QUERY
  WITH picked AS (
    SELECT j.id FROM jobs j
     WHERE j.type = ANY (p_types) AND j.run_after <= now()
       AND (j.status = 'queued'
            OR (j.status = 'running' AND j.locked_at < now() - make_interval(secs => p_lease_seconds)))
     ORDER BY j.run_after, j.created_at
     FOR UPDATE SKIP LOCKED
     LIMIT greatest(1, least(p_limit, 50))
  )
  UPDATE jobs j SET status = 'running', locked_by = p_worker, locked_at = now(), attempts = j.attempts + 1, updated_at = now()
    FROM picked WHERE j.id = picked.id
  RETURNING j.id, j.tenant_id, j.type, j.payload, j.attempts;
END $$;
--> statement-breakpoint

CREATE FUNCTION jobs_complete(p_id uuid, p_worker text) RETURNS boolean
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    WITH u AS (
      UPDATE jobs SET status = 'succeeded', locked_by = NULL, locked_at = NULL, last_error = NULL, updated_at = now()
       WHERE id = p_id AND status = 'running' AND locked_by = p_worker RETURNING 1)
    SELECT EXISTS (SELECT 1 FROM u)
  $$;
--> statement-breakpoint

-- Records a failure. Retries with the given delay until max_attempts is reached, then parks the job as 'dead'.
CREATE FUNCTION jobs_fail(p_id uuid, p_worker text, p_error text, p_retry_seconds int DEFAULT 30) RETURNS text
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    WITH u AS (
      UPDATE jobs
         SET status = CASE WHEN attempts >= max_attempts THEN 'dead'::job_status ELSE 'queued'::job_status END,
             run_after = now() + make_interval(secs => greatest(p_retry_seconds, 0)),
             last_error = left(p_error, 2000), locked_by = NULL, locked_at = NULL, updated_at = now()
       WHERE id = p_id AND status = 'running' AND locked_by = p_worker
       RETURNING status)
    SELECT status::text FROM u
  $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION jobs_claim(text, text[], int, int), jobs_complete(uuid, text), jobs_fail(uuid, text, text, int) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION jobs_claim(text, text[], int, int), jobs_complete(uuid, text), jobs_fail(uuid, text, text, int) TO taxops_worker;
