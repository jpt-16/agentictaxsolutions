import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, Bot, Download, Eye, Info, ShieldAlert } from "lucide-react";
import { can, PROPOSAL_STATUS_LABELS } from "@taxops/core";
import { getProposal, NotFoundError } from "@taxops/services";
import { requireContext } from "@/lib/auth";
import { decimalDiff, formatAmount } from "@/lib/decimal";
import { Badge, Card, CardHeader, ConfidencePill, PageHeader, cn, formatDateTime } from "@/components/ui";
import { DecisionForm } from "./decision";

export const dynamic = "force-dynamic";
export const metadata = { title: "Review AI result" };
const ROWS = 100;
const FIELD_LABELS: Record<string, string> = { account_code: "Account code", account_name: "Account name", debit: "Debit", credit: "Credit", balance: "Balance (signed, split into debit/credit)" };

function Stat({ label, value, tone, hint }: { label: string; value: string; tone?: "red" | "amber"; hint?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface2 px-3.5 py-3">
      <p className="text-[12px] text-muted">{label}</p>
      <p className="tnum mt-0.5 text-[18px] font-semibold text-ink" style={tone ? { color: `var(--${tone}-fg)` } : undefined}>{value}</p>
      {hint && <p className="mt-0.5 text-[11.5px] text-muted">{hint}</p>}
    </div>
  );
}

export default async function ProposalPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ page?: string }> }) {
  const ctx = await requireContext();
  if (!can(ctx.session.role, "proposal.read")) notFound();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const page = Math.max(1, Math.min(1000, Number.parseInt(sp.page ?? "1", 10) || 1));
  let p;
  try { p = await getProposal(ctx, id, { rowOffset: (page - 1) * ROWS, rowLimit: ROWS }); } catch (e) { if (e instanceof NotFoundError) notFound(); throw e; }
  const pl = p.payload;
  const diff = pl ? decimalDiff(pl.stats.sum_debit, pl.stats.sum_credit) : null;
  const pages = Math.max(1, Math.ceil(p.totalRows / ROWS));
  const sheetHref = (row: number) => `/requests/${p.request.id}/files/${p.file.id}?sheet=${encodeURIComponent(p.rows[0]?.sheet ?? "")}#r${row}`;

  return (
    <>
      <PageHeader
        crumbs={[{ href: "/review", label: "AI review" }, { label: p.title }]}
        title={p.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Badge tone={p.status === "accepted" ? "green" : p.status === "rejected" ? "red" : p.status === "pending" ? "violet" : "slate"} dot>{PROPOSAL_STATUS_LABELS[p.status]}</Badge>
            <ConfidencePill value={p.confidence} />
            {pl && <Badge tone={pl.method === "llm" ? "indigo" : "slate"}>{pl.method === "llm" ? "AI-assisted mapping" : "Header match"}</Badge>}
            <span className="inline-flex items-center gap-1.5"><Bot size={14} aria-hidden /> AI-generated · check against the source file</span>
          </span>
        }
      />

      {!pl && (
        <p role="alert" className="mb-4 flex items-start gap-2 rounded-lg px-3.5 py-2.5 text-[13px]" style={{ background: "var(--red-bg)", color: "var(--red-fg)" }}>
          <ShieldAlert size={16} className="mt-0.5 flex-none" aria-hidden /> This result does not match the expected format and cannot be shown in detail. Reject it and ask for the file to be re-processed.
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="space-y-5">
          {pl && (
            <Card>
              <CardHeader title="What the agent read" subtitle={`Sheet “${pl.sheet}” · header on row ${pl.header_row}`} />
              <div className="grid grid-cols-2 gap-3 px-5 py-4 sm:grid-cols-3">
                <Stat label="Accounts read" value={String(pl.stats.row_count)} />
                <Stat label="Total debit" value={formatAmount(pl.stats.sum_debit)} />
                <Stat label="Total credit" value={formatAmount(pl.stats.sum_credit)} />
                <Stat label="Debit − credit" value={formatAmount(diff)} tone={diff !== "0" ? "amber" : undefined} hint={diff === "0" ? "Totals agree" : "Totals differ"} />
                <Stat label="Unreadable cells" value={String(pl.stats.unparsed_cells)} tone={pl.stats.unparsed_cells ? "red" : undefined} />
                <Stat label="Rows to check" value={String(pl.stats.rows_with_issues)} tone={pl.stats.rows_with_issues ? "amber" : undefined} />
              </div>
              {(pl.notes.length > 0 || diff !== "0") && (
                <ul className="space-y-1.5 border-t border-line px-5 py-3.5 text-[13px]">
                  {pl.notes.map((n, i) => <li key={i} className="flex items-start gap-2 text-body"><Info size={14} className="mt-0.5 flex-none text-muted" aria-hidden /> {n}</li>)}
                  {diff !== "0" && <li className="flex items-start gap-2" style={{ color: "var(--amber-fg)" }}><AlertTriangle size={14} className="mt-0.5 flex-none" aria-hidden /> Debits and credits differ. Accepting only confirms the data was read faithfully from the file; the figures themselves are checked by validation.</li>}
                </ul>
              )}
              <div className="border-t border-line px-5 py-4">
                <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">Column mapping</p>
                <table className="tbl !text-[13px]">
                  <thead><tr><th>Standard field</th><th>Source column</th><th>Header in file</th></tr></thead>
                  <tbody>
                    {Object.entries(pl.columns).map(([k, c]) => (
                      <tr key={k}><td className="font-medium text-ink">{FIELD_LABELS[k] ?? k}</td><td className="tnum">Column {c.letter}</td><td className="text-body">{c.header || "—"}</td></tr>
                    ))}
                  </tbody>
                </table>
                {Object.keys(pl.metadata).length > 0 && (
                  <p className="mt-3 text-[12.5px] text-muted">Inferred from the sheet: {Object.entries(pl.metadata).map(([k, v]) => `${k.replace("_", " ")} “${v}”`).join(" · ")}. These are guesses, not facts.</p>
                )}
              </div>
            </Card>
          )}

          <Card>
            <CardHeader title="Standardized rows" subtitle={`${p.totalRows} rows · each links to its source row in the file`} />
            <div className="overflow-x-auto">
              <table className="tbl !text-[13px]">
                <thead><tr><th>Source</th><th>Account</th><th>Name</th><th className="text-right">Debit</th><th className="text-right">Credit</th><th>Checks</th></tr></thead>
                <tbody>
                  {p.rows.map((r) => (
                    <tr key={r.position} className={cn(r.issues.length > 0 && "bg-[var(--amber-bg)]")}>
                      <td className="tnum whitespace-nowrap">{p.file.previewable ? <Link href={sheetHref(r.sourceRow)} className="text-accent hover:underline" title={`Open row ${r.sourceRow} in the file viewer`}>Row {r.sourceRow}</Link> : `Row ${r.sourceRow}`}</td>
                      <td className="tnum text-ink">{r.values.account_code || "—"}</td>
                      <td className="max-w-[240px] truncate text-body" title={r.values.account_name}>{r.values.account_name || "—"}</td>
                      <td className="tnum text-right" title={`from ${r.cells.debit ?? r.cells.balance ?? "—"}`}>{formatAmount(r.values.debit)}</td>
                      <td className="tnum text-right" title={`from ${r.cells.credit ?? r.cells.balance ?? "—"}`}>{formatAmount(r.values.credit)}</td>
                      <td className="max-w-[220px] text-[12px]" style={r.issues.length ? { color: "var(--amber-fg)" } : undefined}>{r.issues.join(" ") || <span className="text-subtle">OK</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {p.totalRows > ROWS && (
              <div className="flex items-center justify-between border-t border-line px-4 py-3 text-[13px] text-muted">
                <span className="tnum">Rows {(page - 1) * ROWS + 1}–{Math.min(page * ROWS, p.totalRows)} of {p.totalRows}</span>
                <div className="flex gap-2">
                  {page > 1 && <Link className="btn btn-secondary btn-sm" href={`/review/${p.id}?page=${page - 1}`}>Previous</Link>}
                  {page < pages && <Link className="btn btn-secondary btn-sm" href={`/review/${p.id}?page=${page + 1}`}>Next</Link>}
                </div>
              </div>
            )}
          </Card>
        </div>

        <aside className="space-y-5">
          <Card>
            <CardHeader title={p.status === "pending" ? "Review" : "Decision"} />
            {p.can.decide ? <DecisionForm proposalId={p.id} /> : (
              <div className="px-5 py-4 text-[13.5px]">
                {p.status === "pending" ? <p className="text-muted">You can view this result but not decide on it.</p> : (
                  <>
                    <p className="text-ink"><strong>{PROPOSAL_STATUS_LABELS[p.status]}</strong>{p.decidedByName ? <> by {p.decidedByName}</> : null}</p>
                    {p.decidedAt && <p className="text-[12.5px] text-muted">{formatDateTime(p.decidedAt)}</p>}
                    {p.decisionNote && <p className="mt-2 whitespace-pre-wrap text-body">“{p.decisionNote}”</p>}
                  </>
                )}
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Source" />
            <dl className="space-y-3 px-5 py-4 text-[13px]">
              <div><dt className="text-muted">Request</dt><dd><Link href={`/requests/${p.request.id}`} className="font-medium text-ink hover:text-accent">{p.request.title}</Link><span className="tnum block text-[12px] text-muted">{p.request.reference} · {p.item.title}</span></dd></div>
              <div>
                <dt className="text-muted">File</dt>
                <dd className="font-medium text-ink">{p.file.name}<span className="block text-[12px] font-normal text-muted">Submitted by {p.submission.by} (v{p.submission.version})</span></dd>
                <dd className="mt-2 flex gap-2">
                  {p.file.previewable && <Link className="btn btn-secondary btn-sm" href={`/requests/${p.request.id}/files/${p.file.id}`}><Eye size={13} aria-hidden /> Open file</Link>}
                  <a className="btn btn-secondary btn-sm" href={`/api/files/${p.file.id}`}><Download size={13} aria-hidden /> Download</a>
                </dd>
              </div>
            </dl>
          </Card>

          {p.run && (
            <Card>
              <CardHeader title="How it was produced" />
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 px-5 py-4 text-[13px]">
                <dt className="text-muted">Agent</dt><dd className="text-right text-ink">{p.run.agent} v{p.run.version}</dd>
                <dt className="text-muted">AI model calls</dt><dd className="tnum text-right text-ink">{p.run.llmCalls}</dd>
                <dt className="text-muted">Model</dt><dd className="text-right text-ink">{p.run.model ?? "None used"}</dd>
                <dt className="text-muted">Prompt</dt><dd className="text-right text-ink">{p.run.promptVersion ?? "—"}</dd>
                <dt className="text-muted">Run time</dt><dd className="tnum text-right text-ink">{p.run.durationMs} ms</dd>
              </dl>
              {p.run.llmCalls === 0 && <p className="border-t border-line px-5 py-3 text-[12px] text-muted">No data was sent to an external AI provider for this result.</p>}
            </Card>
          )}
        </aside>
      </div>
    </>
  );
}
