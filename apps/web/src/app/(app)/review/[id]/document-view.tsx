import { AlertTriangle, FileText, Info } from "lucide-react";
import type { DocumentPayload } from "@taxops/core";
import { Badge, Card, CardHeader } from "@/components/ui";

function Facts({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div>
      <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted">{title}</p>
      {items.length === 0 ? <p className="text-[13px] text-subtle">{empty}</p> : (
        <ul className="flex flex-wrap gap-1.5">{items.map((x) => <li key={x} className="tnum rounded-full border border-line bg-surface2 px-2.5 py-0.5 text-[12.5px] text-ink">{x}</li>)}</ul>
      )}
    </div>
  );
}

/** What the document agent read. Everything shown is plain text from an untrusted file: React escapes it, nothing is rendered as HTML. */
export function DocumentView({ doc, fileName, fileId }: { doc: DocumentPayload; fileName: string; fileId: string; requestId: string }) {
  return (
    <Card>
      <CardHeader title="What the agent read" subtitle={`${doc.document_type} · ${fileName}`} action={<Badge tone={doc.method === "llm" ? "indigo" : "slate"}>{doc.method === "llm" ? "AI-assisted" : "Pattern match"}</Badge>} />
      <div className="space-y-5 px-4 py-4 sm:px-5">
        {doc.summary && (
          <div>
            <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted">Summary (AI, every figure checked against the text)</p>
            <p className="text-[14px] text-ink">{doc.summary}</p>
          </div>
        )}
        {(doc.counterparty || doc.period) && (
          <dl className="grid grid-cols-2 gap-3 text-[13.5px]">
            {doc.counterparty && <div><dt className="text-muted">Counterparty</dt><dd className="font-medium text-ink">{doc.counterparty}</dd></div>}
            {doc.period && <div><dt className="text-muted">Period</dt><dd className="font-medium text-ink">{doc.period}</dd></div>}
          </dl>
        )}
        {doc.key_amounts.length > 0 && (
          <div>
            <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted">Key amounts</p>
            <ul className="divide-y divide-line rounded-xl border border-line">{doc.key_amounts.map((a, i) => <li key={i} className="flex justify-between gap-3 px-3 py-2 text-[13.5px]"><span>{a.label}</span><span className="tnum font-medium text-ink">{a.value}</span></li>)}</ul>
          </div>
        )}
        <Facts title="Amounts found in the text" items={doc.facts.amounts} empty="No amounts with a currency were found." />
        <Facts title="Dates found" items={doc.facts.dates} empty="No dates were found." />
        <Facts title="Years mentioned" items={doc.facts.years} empty="No years were found." />
        <p className="flex items-center gap-2 text-[13px] text-body"><FileText size={14} aria-hidden className="text-muted" /> Signature wording: {doc.facts.signature_cues > 0 ? `${doc.facts.signature_cues} cue(s) found. This does not prove the document is signed; check the original.` : "none found."}</p>
        {doc.excerpt && (
          <details className="rounded-xl border border-line px-3 py-2">
            <summary className="cursor-pointer text-[13px] font-medium text-ink">Start of the document text</summary>
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-[12.5px] text-body">{doc.excerpt}</pre>
          </details>
        )}
        {doc.notes.length > 0 && (
          <ul className="space-y-1.5 text-[13px]">
            {doc.notes.map((n, i) => <li key={i} className="flex items-start gap-2 text-body"><Info size={14} className="mt-0.5 flex-none text-muted" aria-hidden /> {n}</li>)}
          </ul>
        )}
        <p className="flex items-start gap-2 text-[12.5px]" style={{ color: "var(--amber-fg)" }}><AlertTriangle size={14} className="mt-0.5 flex-none" aria-hidden /> <span>Accepting confirms these facts match the document. Open the original to check it: <a className="underline" href={`/api/files/${fileId}`}>download the file</a>.</span></p>
      </div>
    </Card>
  );
}
