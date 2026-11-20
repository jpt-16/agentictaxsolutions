export interface OpsMetrics {
  jobs: Record<string, number>;
  oldest_queued_seconds: number;
  dead_jobs: number;
  proposals_pending: number;
  tenants: number;
  audit_events: number;
}

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

/** Prometheus text exposition. Aggregate counts only: never tenant names, users or content. */
export function renderMetrics(m: OpsMetrics): string {
  const lines: string[] = [];
  const gauge = (name: string, help: string, value: number, labels = "") => { lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}${labels} ${value}`); };
  lines.push("# HELP taxops_jobs Queue jobs by type and status", "# TYPE taxops_jobs gauge");
  for (const [k, n] of Object.entries(m.jobs).sort()) {
    const i = k.lastIndexOf(":");
    lines.push(`taxops_jobs{type="${esc(k.slice(0, i))}",status="${esc(k.slice(i + 1))}"} ${n}`);
  }
  gauge("taxops_queue_oldest_runnable_seconds", "Age of the oldest runnable queued job", m.oldest_queued_seconds);
  gauge("taxops_jobs_dead", "Jobs that exhausted their retries", m.dead_jobs);
  gauge("taxops_proposals_pending", "AI results awaiting human review", m.proposals_pending);
  gauge("taxops_tenants", "Tenants", m.tenants);
  gauge("taxops_audit_events", "Audit events recorded", m.audit_events);
  return lines.join("\n") + "\n";
}
