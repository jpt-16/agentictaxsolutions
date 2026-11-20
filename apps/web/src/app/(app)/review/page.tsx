import Link from "next/link";
import { notFound } from "next/navigation";
import { Bot, Sparkles } from "lucide-react";
import { can, proposalStatusLabel, type ProposalStatus } from "@taxops/core";
import { listProposals } from "@taxops/services";
import { requireContext } from "@/lib/auth";
import { Badge, Card, ConfidencePill, EmptyState, PageHeader, SeverityBadge, cn, formatDateTime } from "@/components/ui";

export const metadata = { title: "AI review" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;
const TABS: { key: ProposalStatus; label: string }[] = [
  { key: "pending", label: "Awaiting review" }, { key: "accepted", label: "Accepted" }, { key: "rejected", label: "Rejected" },
];

export default async function ReviewQueuePage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string; kind?: string }> }) {
  const ctx = await requireContext();
  if (!can(ctx.session.role, "proposal.read")) notFound();
  const sp = await searchParams;
  const status = (TABS.find((t) => t.key === sp.status)?.key ?? "pending") as ProposalStatus;
  const kind = sp.kind === "finding" ? "finding" : "extraction";
  const page = Math.max(1, Math.min(1000, Number.parseInt(sp.page ?? "1", 10) || 1));
  const { rows, total } = await listProposals(ctx, { kind, status, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const qs = (st: string, k = kind) => `/review?${new URLSearchParams({ ...(k === "finding" ? { kind: k } : {}), ...(st !== "pending" ? { status: st } : {}) })}`.replace(/\?$/, "");
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <PageHeader title="AI review" subtitle="Data the AI agents extracted from submitted files. Nothing here is used until a person has checked it against the source." />
      <div role="tablist" aria-label="Kind of result" className="mb-3 inline-flex gap-1 rounded-lg bg-surface2 p-1">
        {([["extraction", "Extracted data"], ["finding", "Validation findings"]] as const).map(([k, label]) => (
          <Link key={k} role="tab" aria-selected={kind === k} href={qs("pending", k)} className={cn("rounded-md px-3 py-1 text-[13px] font-medium", kind === k ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink")}>{label}</Link>
        ))}
      </div>
      <Card>
        <nav aria-label="Filter by status" className="flex gap-1 border-b border-line px-4 py-3">
          {TABS.map((t) => (
            <Link key={t.key} href={qs(t.key)} aria-current={t.key === status ? "page" : undefined}
              className={cn("rounded-md px-2.5 py-1 text-[13px] font-medium", t.key === status ? "bg-accentsoft text-accent" : "text-muted hover:bg-surface2 hover:text-ink")}>{kind === "finding" ? ({ pending: "Open", accepted: "Confirmed", rejected: "Dismissed", superseded: "" } as Record<string, string>)[t.key] : t.label}</Link>
          ))}
        </nav>
        {rows.length === 0 ? (
          <EmptyState icon={<Bot size={18} />} title={status === "pending" ? (kind === "finding" ? "No open findings" : "Nothing to review") : `No ${proposalStatusLabel(kind, status).toLowerCase()} results`}
            body={status === "pending" ? "When a contributor uploads a trial balance and the worker has processed it, the extracted data appears here." : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>Result</th><th>Request</th><th>Source file</th><th>{kind === "finding" ? "Rule" : "Rows"}</th><th>{kind === "finding" ? "Severity" : "Confidence"}</th><th>{status === "pending" ? "Extracted" : "Decided"}</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="row-link">
                    <td className="max-w-[300px]">
                      <Link href={`/review/${r.id}`} className="font-medium text-ink hover:text-accent">{r.title}</Link>
                      <p className="mt-0.5 truncate text-[12px] text-muted">{r.detail}</p>
                    </td>
                    <td className="max-w-[240px]"><Link href={`/requests/${r.requestId}`} className="text-body hover:text-accent">{r.requestTitle}</Link><p className="tnum text-[12px] text-muted">{r.requestRef} · {r.itemTitle}</p></td>
                    <td className="whitespace-nowrap text-body">{r.fileName}</td>
                    <td className="tnum text-body">{kind === "finding" ? r.ruleId : r.rowCount}</td>
                    <td className="whitespace-nowrap"><div className="flex items-center gap-1.5">{kind === "finding" ? <SeverityBadge severity={r.severity} /> : <><ConfidencePill value={r.confidence} />{r.severity === "warning" && <Badge tone="amber">Check</Badge>}</>}</div></td>
                    <td className="whitespace-nowrap text-muted">{formatDateTime((status === "pending" ? r.createdAt : r.decidedAt ?? r.createdAt) as Date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-line px-4 py-3 text-[13px] text-muted">
            <span className="tnum">Page {page} of {pages} · {total} results</span>
            <div className="flex gap-2">
              {page > 1 && <Link className="btn btn-secondary btn-sm" href={`${qs(status)}${qs(status).includes("?") ? "&" : "?"}page=${page - 1}`}>Previous</Link>}
              {page < pages && <Link className="btn btn-secondary btn-sm" href={`${qs(status)}${qs(status).includes("?") ? "&" : "?"}page=${page + 1}`}>Next</Link>}
            </div>
          </div>
        )}
      </Card>
      <p className="mt-3 flex items-center gap-1.5 text-[12.5px] text-muted"><Sparkles size={13} aria-hidden /> AI-generated. Confidence is a guide for where to look first, not a substitute for review.</p>
    </>
  );
}
