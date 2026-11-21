import Link from "next/link";
import { FileText, Plus, Search } from "lucide-react";
import { can, REQUEST_STATUSES, type RequestStatus } from "@taxops/core";
import { listRequests, type RequestListFilters } from "@taxops/services";
import { requireContext } from "@/lib/auth";
import { Card, Chip, EmptyState, PageHeader, PriorityBadge, ProgressBar, RequestStatusBadge, cn, dueLabel, formatDate } from "@/components/ui";

export const metadata = { title: "Information requests" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 15;
const TABS: { key: string; label: string; managerOnly?: boolean }[] = [
  { key: "", label: "All" },
  { key: "active", label: "Active" },
  { key: "overdue", label: "Overdue" },
  { key: "in_review", label: "In review" },
  { key: "changes_requested", label: "Changes requested" },
  { key: "approved", label: "Approved" },
  { key: "draft", label: "Drafts", managerOnly: true },
  { key: "closed", label: "Closed" },
];
const SORTS = { due: "Due date", created: "Newest", title: "Title" } as const;

type Search = { status?: string; q?: string; sort?: string; page?: string };

function href(base: Search, patch: Partial<Search>) {
  const p = new URLSearchParams();
  const merged = { ...base, ...patch };
  for (const [k, v] of Object.entries(merged)) if (v) p.set(k, String(v));
  const s = p.toString();
  return s ? `/requests?${s}` : "/requests";
}

export default async function RequestsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireContext();
  const sp = await searchParams;
  const role = ctx.session.role;
  const tabs = TABS.filter((t) => !t.managerOnly || can(role, "request.read.all"));

  const statusOk = sp.status === "active" || sp.status === "overdue" || (REQUEST_STATUSES as readonly string[]).includes(sp.status ?? "");
  const sort = sp.sort && sp.sort in SORTS ? (sp.sort as keyof typeof SORTS) : "due";
  const page = Math.max(1, Math.min(500, Number.parseInt(sp.page ?? "1", 10) || 1));
  const filters: RequestListFilters = {
    status: statusOk ? (sp.status as RequestStatus | "active" | "overdue") : undefined,
    q: sp.q?.slice(0, 100), sort, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE,
  };
  const { rows, total } = await listRequests(ctx, filters);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const base: Search = { status: statusOk ? sp.status : undefined, q: sp.q, sort: sort === "due" ? undefined : sort };

  return (
    <>
      <PageHeader
        title="Information requests"
        subtitle={can(role, "request.read.all") ? "Everything being collected across departments and subsidiaries." : "Requests assigned to you, your department or your entity."}
        actions={can(role, "request.create") ? <Link href="/requests/new" className="btn btn-primary"><Plus size={15} aria-hidden /> New request</Link> : undefined}
      />

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <nav aria-label="Filter by status" className="segmented">
            {tabs.map((t) => {
              const active = (statusOk ? sp.status : "") === t.key || (!statusOk && t.key === "");
              return (
                <Link key={t.key || "all"} href={href(base, { status: t.key || undefined, page: undefined })} aria-current={active ? "page" : undefined}
                  >
                  {t.label}
                </Link>
              );
            })}
          </nav>
          <form action="/requests" className="flex items-center gap-2" role="search">
            {statusOk && <input type="hidden" name="status" value={sp.status} />}
            <div className="relative">
              <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
              <input name="q" defaultValue={sp.q ?? ""} placeholder="Search title or reference" aria-label="Search requests" className="field w-56 !pl-8" maxLength={100} />
            </div>
            <select name="sort" defaultValue={sort} aria-label="Sort by" className="field !w-auto">
              {Object.entries(SORTS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
            <button type="submit" className="btn btn-secondary">Apply</button>
          </form>
        </div>

        {rows.length === 0 ? (
          <EmptyState icon={<FileText size={18} />} title="No requests match"
            body={sp.q || statusOk ? "Try clearing the filters or searching for something else." : can(role, "request.create") ? "Create your first information request to get started." : "Nothing has been assigned to you yet."}
            action={sp.q || statusOk ? <Link href="/requests" className="btn btn-secondary">Clear filters</Link> : can(role, "request.create") ? <Link href="/requests/new" className="btn btn-primary">New request</Link> : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl stack">
              <thead><tr><th>Request</th><th>Assigned to</th><th>Due</th><th>Priority</th><th>Progress</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="row-link">
                    <td className="max-w-[320px]" data-label="Request" data-primary>
                      <Link href={`/requests/${r.id}`} className="font-semibold text-ink hover:text-accent">{r.title}</Link>
                      <div className="tnum mt-0.5 text-[12px] text-muted">{r.reference} · FY{r.taxYear}</div>
                    </td>
                    <td className="max-w-[240px]" data-label="Assigned to">
                      <div className="flex flex-wrap gap-1">
                        {r.assignees.slice(0, 2).map((a) => <Chip key={a.type + a.id} kind={a.type}>{a.label}</Chip>)}
                        {r.assignees.length > 2 && <span className="self-center text-[12px] text-muted">+{r.assignees.length - 2} more</span>}
                        {r.assignees.length === 0 && <span className="text-[12px] text-subtle">Unassigned</span>}
                      </div>
                    </td>
                    <td className="whitespace-nowrap" data-label="Due">
                      <div className="tnum text-ink">{formatDate(r.dueDate)}</div>
                      {r.status !== "draft" && (
                        <div className={cn("text-[12px]", r.overdue ? "font-medium" : "text-muted")} style={r.overdue ? { color: "var(--red-fg)" } : undefined}>
                          {r.status === "approved" || r.status === "closed" ? "Complete" : dueLabel(r.daysLeft, r.overdue)}
                        </div>
                      )}
                    </td>
                    <td data-label="Priority"><PriorityBadge priority={r.priority} /></td>
                    <td data-label="Progress">{r.itemCount ? <ProgressBar value={r.approvedCount} max={r.itemCount} label={`${r.title} progress`} /> : <span className="text-[12px] text-subtle">No items</span>}</td>
                    <td data-label="Status"><RequestStatusBadge status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-line px-4 py-3 text-[13px] text-muted">
            <span className="tnum">Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}</span>
            <div className="flex gap-2">
              {page > 1 && <Link className="btn btn-secondary btn-sm" href={href(base, { page: String(page - 1) })}>Previous</Link>}
              {page < pages && <Link className="btn btn-secondary btn-sm" href={href(base, { page: String(page + 1) })}>Next</Link>}
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
