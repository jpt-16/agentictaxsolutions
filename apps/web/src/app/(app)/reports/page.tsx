import Link from "next/link";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { can, REQUEST_STATUS_LABELS, type RequestStatus } from "@taxops/core";
import { requestStatusReport } from "@taxops/services";
import { requireContext } from "@/lib/auth";
import { Card, CardHeader, EmptyState, PageHeader, PriorityBadge, ProgressBar, RequestStatusBadge, formatDate, dueLabel, cn } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reports" };
const BAR: Record<RequestStatus, string> = {
  draft: "var(--bar-draft)", open: "var(--bar-open)", in_progress: "var(--bar-progress)", changes_requested: "var(--bar-changes)",
  in_review: "var(--bar-review)", approved: "var(--bar-approved)", closed: "var(--bar-closed)",
};

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "red" }) {
  return (
    <div className="group p-4">
      <p className="text-[12.5px] font-medium text-muted">{label}</p>
      <p className="tnum mt-2 text-[28px] font-semibold leading-none text-ink">{value}</p>
      {hint && <p className="mt-1.5 text-[12.5px] text-muted" style={tone ? { color: `var(--${tone}-fg)`, fontWeight: 500 } : undefined}>{hint}</p>}
    </div>
  );
}

export default async function ReportsPage() {
  const ctx = await requireContext();
  if (!can(ctx.session.role, "report.read")) notFound();
  const r = await requestStatusReport(ctx);
  const s = r.summary;
  const statuses = (Object.keys(s.byStatus) as RequestStatus[]).filter((k) => s.byStatus[k] > 0);
  return (
    <>
      <PageHeader title="Reports" subtitle="Where every request stands, and the approved data behind it."
        actions={<form method="post" action="/api/reports/status"><button className="btn btn-secondary" type="submit"><Download size={15} aria-hidden /> Status report (CSV)</button></form>} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Requests" value={String(s.total)} hint={`${s.overdue} overdue`} tone={s.overdue ? "red" : undefined} />
        <Kpi label="Items approved" value={`${s.completionPct}%`} hint="Across all requests" />
        <Kpi label="Average time to close" value={s.avgCycleDays === null ? "–" : `${s.avgCycleDays} d`} hint={s.closedCount ? `${s.closedCount} closed request(s)` : "No closed requests yet"} />
        <Kpi label="Closed on time" value={s.onTimePct === null ? "–" : `${s.onTimePct}%`} hint="Closed on or before the deadline" />
      </div>

      <Card className="mt-5">
        <CardHeader title="By status" />
        <div className="px-4 py-4 sm:px-5">
          {s.total === 0 ? <p className="text-[13px] text-muted">No requests yet.</p> : (
            <>
              <div className="flex h-2.5 overflow-hidden rounded-full" role="img" aria-label={statuses.map((k) => `${s.byStatus[k]} ${REQUEST_STATUS_LABELS[k]}`).join(", ")}>
                {statuses.map((k) => <span key={k} style={{ width: `${(s.byStatus[k] / s.total) * 100}%`, background: BAR[k] }} />)}
              </div>
              <ul className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
                {statuses.map((k) => <li key={k} className="flex items-center gap-2 text-[13px]"><span className="h-2.5 w-2.5 rounded-full" style={{ background: BAR[k] }} aria-hidden /> <span className="text-body">{REQUEST_STATUS_LABELS[k]}</span> <span className="tnum ml-auto font-medium text-ink">{s.byStatus[k]}</span></li>)}
              </ul>
            </>
          )}
        </div>
      </Card>

      <Card className="mt-5">
        <CardHeader title="All requests" subtitle="The data pack is what a person has accepted, with where each figure came from" />
        {r.rows.length === 0 ? <EmptyState title="No requests yet" /> : (
          <div className="overflow-x-auto">
            <table className="tbl stack">
              <thead><tr><th>Request</th><th>Due</th><th>Priority</th><th>Progress</th><th>Status</th><th><span className="sr-only">Export</span></th></tr></thead>
              <tbody>
                {r.rows.map((x) => (
                  <tr key={x.reference}>
                    <td data-label="Request" data-primary><span className="font-semibold text-ink">{x.title}</span><div className="tnum mt-0.5 text-[12px] text-muted">{x.reference} · FY{x.tax_year}</div></td>
                    <td data-label="Due" className="whitespace-nowrap"><div className="tnum text-ink">{formatDate(x.due_date)}</div>
                      {x.status !== "draft" && <div className={cn("text-[12px]", x.overdue ? "font-medium" : "text-muted")} style={x.overdue ? { color: "var(--red-fg)" } : undefined}>{x.status === "approved" || x.status === "closed" ? "Complete" : dueLabel(x.days_left, x.overdue)}</div>}</td>
                    <td data-label="Priority"><PriorityBadge priority={x.priority as "low" | "medium" | "high"} /></td>
                    <td data-label="Progress">{x.items_total ? <ProgressBar value={x.items_approved} max={x.items_total} label={`${x.title} progress`} /> : <span className="text-[12px] text-subtle">No items</span>}</td>
                    <td data-label="Status"><RequestStatusBadge status={x.status} /></td>
                    <td className="text-right">{x.items_approved > 0 || x.status === "closed" ? <DataPack reference={x.reference} requestId={x.request_id} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="hint mt-3">Exports are recorded in the <Link className="text-accent" href="/audit">audit history</Link>.</p>
    </>
  );
}

function DataPack({ requestId, reference }: { requestId: string; reference: string }) {
  return (
    <form method="post" action="/api/reports/data">
      <input type="hidden" name="requestId" value={requestId} />
      <button className="btn btn-ghost btn-sm" type="submit" aria-label={`Download approved data for ${reference}`}><Download size={14} aria-hidden /> Data pack</button>
    </form>
  );
}
