"use client";
import { useState, useTransition } from "react";
import { Wrench } from "lucide-react";
import { requestRemapAction } from "../actions";
import { safely } from "@/lib/safe-action";

const FIELDS: { key: string; label: string }[] = [
  { key: "account_code", label: "Account code" }, { key: "account_name", label: "Account name" },
  { key: "debit", label: "Debit" }, { key: "credit", label: "Credit" }, { key: "balance", label: "Balance (signed)" },
];
const letter = (i: number) => { let s = "", n = i + 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };

export function RemapForm({ proposalId, rows, initialHeaderRow, initial }: { proposalId: string; rows: string[][]; initialHeaderRow: number; initial: Record<string, string> }) {
  const width = Math.max(1, ...rows.map((r) => r.length));
  const letters = Array.from({ length: width }, (_, i) => letter(i));
  const [open, setOpen] = useState(false);
  const [headerRow, setHeaderRow] = useState(String(initialHeaderRow));
  const [cols, setCols] = useState<Record<string, string>>(initial);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = () => {
    setMsg(null);
    const columns = Object.fromEntries(Object.entries(cols).filter(([, v]) => v));
    start(async () => {
      const r = await safely(() => requestRemapAction(proposalId, Number(headerRow), columns));
      setMsg(r.ok ? { ok: true, text: "Re-extraction queued. The corrected result replaces this one when the worker has processed it; refresh in a moment." } : { ok: false, text: r.error });
    });
  };

  if (!open) return <div className="px-5 py-4"><button className="btn btn-secondary w-full" onClick={() => setOpen(true)}><Wrench size={14} aria-hidden /> Fix column mapping…</button></div>;
  return (
    <div className="space-y-3 px-5 py-4">
      <p className="hint">Pick which column holds what, from the first rows of the sheet. The data is re-read from the file and checked before anything is proposed.</p>
      <div className="max-h-48 overflow-auto rounded-md border border-line">
        <table className="w-full border-collapse text-[11.5px]">
          <thead><tr><th className="sticky top-0 bg-surface2 px-1.5 py-1" />{letters.map((l) => <th key={l} className="sticky top-0 bg-surface2 px-2 py-1 text-center text-muted">{l}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i} className={String(i + 1) === headerRow ? "bg-[var(--accent-soft)]" : undefined}>
              <th scope="row" className="tnum bg-surface2 px-1.5 py-0.5 text-right text-subtle">{i + 1}</th>
              {letters.map((_, c) => <td key={c} className="max-w-[110px] truncate px-2 py-0.5 text-body" title={r[c] ?? ""}>{r[c] ?? ""}</td>)}
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div>
        <label className="label" htmlFor="hdr">Header row</label>
        <input id="hdr" className="field !w-24 tnum" inputMode="numeric" value={headerRow} onChange={(e) => setHeaderRow(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {FIELDS.map((f) => (
          <div key={f.key}>
            <label className="label" htmlFor={`m-${f.key}`}>{f.label}</label>
            <select id={`m-${f.key}`} className="field" value={cols[f.key] ?? ""} onChange={(e) => setCols((c) => ({ ...c, [f.key]: e.target.value }))}>
              <option value="">Not present</option>
              {letters.map((l) => <option key={l} value={l}>Column {l}</option>)}
            </select>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button className="btn btn-primary btn-sm" disabled={pending} onClick={submit}>{pending ? "Queuing…" : "Re-extract with this mapping"}</button>
        <button className="btn btn-ghost btn-sm" disabled={pending} onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {msg && <p role={msg.ok ? "status" : "alert"} className="text-[12.5px]" style={{ color: msg.ok ? "var(--green-fg)" : "var(--red-fg)" }}>{msg.text}</p>}
    </div>
  );
}
