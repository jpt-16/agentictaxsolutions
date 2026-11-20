import Link from "next/link";
import { notFound } from "next/navigation";
import { History, ShieldAlert, ShieldCheck } from "lucide-react";
import { can } from "@taxops/core";
import { listAudit, verifyAuditTrail } from "@taxops/services";
import { requireContext } from "@/lib/auth";
import { Badge, Card, EmptyState, PageHeader, formatDateTime } from "@/components/ui";

export const metadata = { title: "Audit history" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 30;
const CATEGORIES = [
  { key: "", label: "All activity" }, { key: "request.", label: "Requests" }, { key: "item.", label: "Items & reviews" }, { key: "comment.", label: "Comments" },
];
type Search = { cat?: string; q?: string; page?: string; verify?: string };

function tone(action: string) {
  if (action.endsWith("approved") || action.endsWith("published") || action.endsWith("closed")) return "green" as const;
  if (action.endsWith("changes_requested")) return "amber" as const;
  if (action.endsWith("submitted")) return "violet" as const;
  if (action.endsWith("status_changed")) return "indigo" as const;
  return "slate" as const;
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireContext();
  if (!can(ctx.session.role, "audit.read")) notFound();
  const sp = await searchParams;
  const cat = CATEGORIES.some((c) => c.key === sp.cat) ? sp.cat : "";
  const page = Math.max(1, Math.min(10_000, Number.parseInt(sp.page ?? "1", 10) || 1));
  const { rows, total } = await listAudit(ctx, { actionPrefix: cat || undefined, q: sp.q?.slice(0, 100), limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const verification = sp.verify ? await verifyAuditTrail(ctx) : null;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ cat, q: sp.q, ...patch })) if (v) p.set(k, v);
    return `/audit${p.size ? `?${p}` : ""}`;
  };

  return (
    <>
      <PageHeader title="Audit history" subtitle="An append-only record of every action and change, who made it, and when."
        actions={<Link href={qs({ verify: "1" })} className="btn btn-secondary"><ShieldCheck size={15} aria-hidden /> Verify integrity</Link>} />

      {verification && (
        <p role="status" className="mb-4 flex items-start gap-2.5 rounded-xl px-4 py-3 text-[13.5px]"
          style={verification.ok ? { background: "var(--green-bg)", color: "var(--green-fg)" } : { background: "var(--red-bg)", color: "var(--red-fg)" }}>
          {verification.ok ? <ShieldCheck size={18} className="mt-0.5 flex-none" aria-hidden /> : <ShieldAlert size={18} className="mt-0.5 flex-none" aria-hidden />}
          {verification.ok
            ? <span><strong>Chain intact.</strong> All {verification.checked} events were re-hashed and match; no entry has been altered, removed or reordered.</span>
            : <span><strong>Integrity check failed</strong> at event #{verification.brokenSeq}. The history has been modified outside the application. Escalate to your security team.</span>}
        </p>
      )}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <nav aria-label="Filter by category" className="flex flex-wrap gap-1">
            {CATEGORIES.map((c) => (
              <Link key={c.key || "all"} href={qs({ cat: c.key || undefined, page: undefined })} aria-current={cat === c.key ? "page" : undefined}
                className={`rounded-md px-2.5 py-1 text-[13px] font-medium ${cat === c.key ? "bg-accentsoft text-accent" : "text-muted hover:bg-surface2 hover:text-ink"}`}>{c.label}</Link>
            ))}
          </nav>
          <form action="/audit" role="search" className="flex gap-2">
            {cat && <input type="hidden" name="cat" value={cat} />}
            <input name="q" defaultValue={sp.q ?? ""} className="field w-60" placeholder="Search summary or person" aria-label="Search audit log" maxLength={100} />
            <button className="btn btn-secondary" type="submit">Search</button>
          </form>
        </div>

        {rows.length === 0 ? <EmptyState icon={<History size={18} />} title="No events found" /> : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>#</th><th>When</th><th>Who</th><th>Event</th><th>What happened</th></tr></thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td className="tnum text-muted">{e.seq}</td>
                    <td className="whitespace-nowrap text-muted">{formatDateTime(e.occurredAt)}</td>
                    <td className="whitespace-nowrap text-ink">{e.actorLabel}</td>
                    <td><Badge tone={tone(e.action)}>{e.action}</Badge></td>
                    <td className="max-w-[460px]">
                      <p className="text-ink">{e.requestRef ? <Link href={`/requests/${e.requestRef}`} className="hover:text-accent">{e.summary}</Link> : e.summary}</p>
                      {(e.before != null || e.after != null) && (
                        <details className="mt-1.5">
                          <summary className="cursor-pointer text-[12px] text-muted hover:text-ink">View change</summary>
                          <div className="mt-2 grid gap-2 sm:grid-cols-2">
                            {([["Before", e.before], ["After", e.after]] as const).map(([label, v]) => (
                              <div key={label}>
                                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-subtle">{label}</p>
                                <pre className="max-h-48 overflow-auto rounded-md bg-surface2 p-2 text-[11.5px] leading-snug text-body">{v == null ? "—" : JSON.stringify(v, null, 2)}</pre>
                              </div>
                            ))}
                          </div>
                          <p className="mt-2 break-all font-mono text-[10.5px] text-subtle">sha256 {e.hash}</p>
                        </details>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-line px-4 py-3 text-[13px] text-muted">
            <span className="tnum">Page {page} of {pages} · {total} events</span>
            <div className="flex gap-2">
              {page > 1 && <Link className="btn btn-secondary btn-sm" href={qs({ page: String(page - 1) })}>Newer</Link>}
              {page < pages && <Link className="btn btn-secondary btn-sm" href={qs({ page: String(page + 1) })}>Older</Link>}
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
