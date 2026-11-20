"use client";
import { useState, useTransition } from "react";
import { updateRuleAction } from "./actions";
import { SeverityBadge } from "@/components/ui";

interface Props {
  id: string; name: string; description: string; severity: string; enabled: boolean; params: Record<string, string>; defaults: Record<string, string>; customized: boolean; editable: boolean;
}
const LABELS: Record<string, string> = { tolerance: "Tolerance (amount)", min_amount: "Ignore balances below", min_rows: "Minimum accounts" };

export function RuleRow(r: Props) {
  const [enabled, setEnabled] = useState(r.enabled);
  const [params, setParams] = useState(r.params);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = enabled !== r.enabled || JSON.stringify(params) !== JSON.stringify(r.params);
  return (
    <li className="px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-medium text-ink">{r.name} <SeverityBadge severity={r.severity as "info" | "warning" | "error"} />{r.customized && <span className="text-[11px] font-normal text-muted">customized</span>}</p>
          <p className="mt-0.5 text-[13px] text-muted">{r.description}</p>
        </div>
        <label className="flex flex-none items-center gap-2 text-[13px] text-body">
          <input type="checkbox" checked={enabled} disabled={!r.editable} onChange={(e) => setEnabled(e.target.checked)} aria-label={`Enable ${r.name}`} /> {enabled ? "On" : "Off"}
        </label>
      </div>
      {Object.keys(r.defaults).length > 0 && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          {Object.keys(r.defaults).map((k) => (
            <div key={k}>
              <label className="label" htmlFor={`${r.id}-${k}`}>{LABELS[k] ?? k}</label>
              <input id={`${r.id}-${k}`} className="field !w-36 tnum" inputMode="decimal" value={params[k] ?? ""} disabled={!r.editable || !enabled}
                onChange={(e) => setParams((p) => ({ ...p, [k]: e.target.value }))} />
            </div>
          ))}
        </div>
      )}
      {r.editable && (
        <div className="mt-3 flex items-center gap-3">
          <button className="btn btn-secondary btn-sm" disabled={!dirty || pending}
            onClick={() => { setMsg(null); start(async () => { const res = await updateRuleAction(r.id, enabled, params); setMsg(res.ok ? { ok: true, text: "Saved. Applies the next time validation runs." } : { ok: false, text: res.error }); }); }}>
            {pending ? "Saving…" : "Save"}
          </button>
          {msg && <span role={msg.ok ? "status" : "alert"} className="text-[12.5px]" style={{ color: msg.ok ? "var(--green-fg)" : "var(--red-fg)" }}>{msg.text}</span>}
        </div>
      )}
    </li>
  );
}
