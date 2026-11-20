"use client";
import { useState, useTransition } from "react";
import { ShieldCheck } from "lucide-react";
import { updateTenantSettingsAction } from "./actions";

export function GovernanceForm({ ai, external }: { ai: boolean; external: boolean }) {
  const [a, setA] = useState(ai), [e, setE] = useState(external);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = a !== ai || e !== external;
  return (
    <div className="space-y-4 px-5 py-4">
      <label className="flex items-start gap-3">
        <input type="checkbox" className="mt-1" checked={a} onChange={(x) => { setA(x.target.checked); if (!x.target.checked) setE(false); }} />
        <span><span className="block font-medium text-ink">AI extraction</span><span className="text-[13px] text-muted">Allow AI agents to read uploaded files and propose standardized data. People review every result. Works without sending anything outside this system.</span></span>
      </label>
      <label className="flex items-start gap-3">
        <input type="checkbox" className="mt-1" checked={e} disabled={!a} onChange={(x) => setE(x.target.checked)} />
        <span><span className="block font-medium text-ink">Allow an external AI model</span><span className="text-[13px] text-muted">Lets the agents send <strong>excerpts of your files</strong> (with sensitive identifiers masked) to an external model provider when a layout is unclear. Leave off to keep every file inside this system.</span></span>
      </label>
      <div className="flex items-center gap-3">
        <button className="btn btn-primary btn-sm" disabled={!dirty || pending}
          onClick={() => { if (e && !external && !window.confirm("Allow excerpts of your files to be sent to an external AI model provider?")) return; setMsg(null); start(async () => { const r = await updateTenantSettingsAction(a, e); setMsg(r.ok ? { ok: true, text: "Saved." } : { ok: false, text: r.error }); }); }}>
          <ShieldCheck size={13} aria-hidden /> {pending ? "Saving…" : "Save"}
        </button>
        {msg && <span role={msg.ok ? "status" : "alert"} className="text-[12.5px]" style={{ color: msg.ok ? "var(--green-fg)" : "var(--red-fg)" }}>{msg.text}</span>}
      </div>
    </div>
  );
}
