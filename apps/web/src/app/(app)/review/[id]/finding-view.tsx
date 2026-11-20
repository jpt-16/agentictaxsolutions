import Link from "next/link";
import { Lightbulb, Sparkles } from "lucide-react";
import { Badge, Card, CardHeader } from "@/components/ui";
import type { getProposal } from "@taxops/services";

type P = Awaited<ReturnType<typeof getProposal>>;

export function FindingView({ p }: { p: P }) {
  const f = p.finding;
  if (!f) return <p role="alert" className="rounded-lg px-3.5 py-2.5 text-[13px]" style={{ background: "var(--red-bg)", color: "var(--red-fg)" }}>This finding does not match the expected format.</p>;
  const rowLink = (row: number, sheet: string) => `/requests/${p.request.id}/files/${p.file.id}?sheet=${encodeURIComponent(sheet)}#r${row}`;
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="What was found" subtitle={`Rule: ${f.rule_name} · sheet “${f.sheet}”`} />
        <div className="space-y-4 px-5 py-4 text-[14px]">
          <p className="text-ink">{f.summary}</p>
          <div className="rounded-lg border border-line bg-surface2 px-4 py-3">
            <p className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted">
              {f.explanation_source === "llm" ? <><Sparkles size={13} aria-hidden /> Explanation written by an AI model</> : <>Explanation</>}
            </p>
            <p className="text-body">{f.explanation}</p>
            {f.explanation_source === "llm" && <p className="mt-1.5 text-[12px] text-muted">Checked automatically: it uses only figures from the finding itself.</p>}
          </div>
          <p className="flex items-start gap-2 text-body"><Lightbulb size={16} className="mt-0.5 flex-none text-muted" aria-hidden /> <span><strong className="text-ink">Suggested next step.</strong> {f.suggestion}</span></p>
        </div>
      </Card>

      <Card>
        <CardHeader title="Evidence" subtitle={f.evidence.length ? "Rows in the source file that this finding is based on" : "This finding concerns the sheet as a whole"} />
        {f.evidence.length === 0 ? <p className="px-5 py-4 text-[13px] text-muted">No individual rows; see the figures below.</p> : (
          <table className="tbl !text-[13px]">
            <thead><tr><th>Source</th><th>Cells</th><th>Why it matters</th></tr></thead>
            <tbody>{f.evidence.map((e, i) => (
              <tr key={i}>
                <td className="tnum whitespace-nowrap">{p.file.previewable ? <Link href={rowLink(e.row, e.sheet)} className="text-accent hover:underline">Row {e.row}</Link> : `Row ${e.row}`}</td>
                <td className="tnum text-body">{e.cells.join(", ") || "—"}</td>
                <td className="text-body">{e.note}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
        {Object.keys(f.metrics).length > 0 && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-line px-5 py-3.5 text-[13px] sm:grid-cols-3">
            {Object.entries(f.metrics).filter(([, v]) => typeof v === "string" || typeof v === "number").map(([k, v]) => (
              <div key={k}><dt className="text-[12px] text-muted">{k.replace(/_/g, " ")}</dt><dd className="tnum font-medium text-ink">{String(v)}</dd></div>
            ))}
          </dl>
        )}
      </Card>
      {p.source && <p className="text-[13px] text-muted">Raised against <Link href={`/review/${p.source.id}`} className="text-accent hover:underline">{p.source.title}</Link>, which a person accepted.</p>}
      <Badge tone="slate">Deterministic rule · no AI model decided this</Badge>
    </div>
  );
}
