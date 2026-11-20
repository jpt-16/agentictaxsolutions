import Link from "next/link";
import { AlertTriangle, CalendarClock, CheckCircle2, ClipboardCheck, FileStack, Plus, ArrowRight, Inbox } from "lucide-react";
import { can, REQUEST_STATUSES, REQUEST_STATUS_LABELS, ROLE_LABELS, type RequestStatus } from "@taxops/core";
import { getDashboard } from "@taxops/services";
import { requireContext } from "@/lib/auth";
import {
  Card, CardHeader, EmptyState, PageHeader, PriorityBadge, ProgressBar, RequestStatusBadge, ItemStatusBadge,
  dueLabel, formatDate, formatDateTime, cn,
} from "@/components/ui";

export const metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

const BAR: Record<RequestStatus, string> = {
  draft: "var(--bar-draft)", open: "var(--bar-open)", in_progress: "var(--bar-progress)", changes_requested: "var(--bar-changes)",
  in_review: "var(--bar-review)", approved: "var(--bar-approved)", closed: "var(--bar-closed)",
};

function Kpi({ label, value, hint, icon: Icon, href, tone }: {
  label: string; value: string | number; hint: string; icon: typeof FileStack; href?: string; tone?: "red" | "amber";
}) {
  const body = (
    <div className="flex h-full flex-col rounded-xl border border-line bg-surface p-4 transition-colors hover:border-linestrong" style={{ boxShadow: "var(--shadow)" }}>
      <div className="flex items-center justify-between text-muted">
        <span className="text-[12.5px] font-medium">{label}</span>
        <Icon size={16} aria-hidden style={tone ? { color: `var(--${tone}-fg)` } : undefined} />
      </div>
      <p className="tnum mt-2 text-[28px] font-semibold leading-none tracking-tight text-ink" style={tone && Number(value) > 0 ? { color: `var(--${tone}-fg)` } : undefined}>{value}</p>
      <p className="mt-2 text-[12px] text-muted">{hint}</p>
    </div>
  );
  return href ? <Link href={href} className="block">{body}</Link> : body;
}

export default async function DashboardPage() {
  const ctx = await requireContext();
  const d = await getDashboard(ctx);
  const { role, name } = ctx.session;
  const total = REQUEST_STATUSES.reduce((n, s) => n + d.byStatus[s], 0);
  const queueTitle = d.queueKind === "submit" ? "Your tasks" : "Awaiting your review";
  const queueSub = d.queueKind === "submit" ? "Information you still need to provide" : "Submissions ready for approval";

  return (
    <>
      <PageHeader
        title={`Welcome back, ${name.split(" ")[0]}`}
        subtitle={`${ROLE_LABELS[role]} · FY2025 close and compliance overview`}
        actions={can(role, "request.create") ? (
          <Link href="/requests/new" className="btn btn-primary"><Plus size={15} aria-hidden /> New request</Link>
        ) : undefined}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label="Active requests" value={d.kpis.activeRequests} hint="Open or in progress" icon={FileStack} href="/requests?status=active" />
        <Kpi label="Overdue" value={d.kpis.overdue} hint="Past their deadline" icon={AlertTriangle} href="/requests?status=overdue" tone="red" />
        <Kpi label="Due in 7 days" value={d.kpis.dueSoon} hint="Upcoming deadlines" icon={CalendarClock} tone="amber" />
        <Kpi label="Awaiting review" value={d.kpis.awaitingReview} hint="Items submitted, not yet reviewed" icon={ClipboardCheck} href="/requests?status=in_review" />
        <Kpi label="Items approved" value={`${d.kpis.completionPct}%`} hint="Across active requests" icon={CheckCircle2} />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_380px]">
        <div className="space-y-5">
          <Card>
            <CardHeader title="Upcoming deadlines" subtitle="Soonest first, including overdue work"
              action={<Link href="/requests?sort=due" className="btn btn-ghost btn-sm">View all <ArrowRight size={13} aria-hidden /></Link>} />
            {d.upcoming.length === 0 ? (
              <EmptyState icon={<CalendarClock size={18} />} title="Nothing due" body="There are no active requests with deadlines right now." />
            ) : (
              <div className="overflow-x-auto">
                <table className="tbl">
                  <thead><tr><th>Request</th><th>Due</th><th>Progress</th><th>Status</th></tr></thead>
                  <tbody>
                    {d.upcoming.map((r) => (
                      <tr key={r.id} className="row-link">
                        <td>
                          <Link href={`/requests/${r.id}`} className="font-medium text-ink hover:text-accent">{r.title}</Link>
                          <div className="mt-0.5 flex items-center gap-2 text-[12px] text-muted"><span className="tnum">{r.reference}</span><PriorityBadge priority={r.priority} /></div>
                        </td>
                        <td className="whitespace-nowrap">
                          <div className="tnum text-ink">{formatDate(r.dueDate)}</div>
                          <div className={cn("text-[12px]", r.overdue ? "font-medium" : "text-muted")} style={r.overdue ? { color: "var(--red-fg)" } : undefined}>{dueLabel(r.daysLeft, r.overdue)}</div>
                        </td>
                        <td><ProgressBar value={r.approvedCount} max={r.itemCount} label={`${r.title} progress`} /></td>
                        <td><RequestStatusBadge status={r.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Requests by status" subtitle={`${total} request${total === 1 ? "" : "s"} you can see`} />
            <div className="px-5 py-4">
              {total === 0 ? <p className="text-muted">No requests yet.</p> : (
                <>
                  <div className="flex h-2.5 overflow-hidden rounded-full" role="img"
                    aria-label={REQUEST_STATUSES.filter((s) => d.byStatus[s]).map((s) => `${REQUEST_STATUS_LABELS[s]}: ${d.byStatus[s]}`).join(", ")}>
                    {REQUEST_STATUSES.filter((s) => d.byStatus[s] > 0).map((s) => (
                      <div key={s} style={{ width: `${(d.byStatus[s] / total) * 100}%`, background: BAR[s] }} />
                    ))}
                  </div>
                  <ul className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
                    {REQUEST_STATUSES.map((s) => (
                      <li key={s} className="flex items-center justify-between gap-2 text-[13px]">
                        <span className="flex items-center gap-2 text-body"><span aria-hidden className="h-2 w-2 rounded-full" style={{ background: BAR[s] }} />{REQUEST_STATUS_LABELS[s]}</span>
                        <span className="tnum font-medium text-ink">{d.byStatus[s]}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </Card>
        </div>

        <div className="space-y-5">
          {d.queueKind && (
            <Card>
              <CardHeader title={queueTitle} subtitle={queueSub} />
              {d.queue.length === 0 ? (
                <EmptyState icon={<Inbox size={18} />} title="You’re all caught up" body="Nothing needs your attention right now." />
              ) : (
                <ul className="divide-y divide-line">
                  {d.queue.map((q) => (
                    <li key={q.itemId}>
                      <Link href={`/requests/${q.requestId}#item-${q.itemId}`} className="block px-5 py-3 transition-colors hover:bg-surface2">
                        <div className="flex items-start justify-between gap-3">
                          <p className="font-medium text-ink">{q.itemTitle}</p>
                          <ItemStatusBadge status={q.status} />
                        </div>
                        <p className="mt-0.5 text-[12px] text-muted">
                          <span className="tnum">{q.reference}</span> · due {formatDate(q.dueDate)}
                          {q.overdue && <span className="font-medium" style={{ color: "var(--red-fg)" }}> · overdue</span>}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          <Card>
            <CardHeader title="Recent activity" subtitle="Latest changes across your requests" />
            {d.recent.length === 0 ? (
              <EmptyState title="No activity yet" />
            ) : (
              <ol className="px-5 py-3">
                {d.recent.map((e) => (
                  <li key={e.id} className="relative border-l border-line pb-4 pl-4 last:pb-1">
                    <span aria-hidden className="absolute -left-[4.5px] top-1.5 h-2 w-2 rounded-full" style={{ background: "var(--line-strong)" }} />
                    <p className="text-[13px] text-ink">{e.summary}</p>
                    <p className="text-[12px] text-muted">{e.actorLabel} · {formatDateTime(e.occurredAt)}</p>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
