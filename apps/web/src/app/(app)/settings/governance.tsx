"use client";
import { useState, useTransition } from "react";
import { ShieldCheck } from "lucide-react";
import { useConfirm, useToast } from "@/components/overlays";
import { updateTenantSettingsAction } from "./actions";
import { safely } from "@/lib/safe-action";

export function GovernanceForm({ ai, external, limit, used }: { ai: boolean; external: boolean; limit: number; used: number }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [a, setA] = useState(ai), [e, setE] = useState(external);
  const [lim, setLim] = useState(String(limit));
  const limNum = /^\d{1,6}$/.test(lim.trim()) ? Number(lim) : null;
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = (a !== ai || e !== external || limNum !== limit) && limNum !== null;
  return (
    <div className="space-y-4 px-5 py-4">
      <label className="flex items-start justify-between gap-4">
        <input type="checkbox" role="switch" className="switch order-2" checked={a} onChange={(x) => { setA(x.target.checked); if (!x.target.checked) setE(false); }} />
        <span className="min-w-0"><span className="block font-medium text-ink">AI extraction</span><span className="text-[13px] text-muted">Allow AI agents to read uploaded files and propose standardized data. People review every result. Works without sending anything outside this system.</span></span>
      </label>
      <label className="flex items-start justify-between gap-4">
        <input type="checkbox" role="switch" className="switch order-2" checked={e} disabled={!a} onChange={(x) => setE(x.target.checked)} />
        <span className="min-w-0"><span className="block font-medium text-ink">Allow an external AI model</span><span className="text-[13px] text-muted">Lets the agents send <strong>excerpts of your files</strong> (with sensitive identifiers masked) to an external model provider when a layout is unclear. Leave off to keep every file inside this system.</span></span>
      </label>
      <div className="space-y-1.5">
        <label htmlFor="llm-limit" className="block font-medium text-ink">Daily limit on external AI calls</label>
        <div className="flex flex-wrap items-center gap-3">
          <input id="llm-limit" className="field !w-32" inputMode="numeric" autoComplete="off" value={lim} onChange={(x) => setLim(x.target.value)} aria-invalid={limNum === null ? true : undefined} aria-describedby="llm-limit-hint" disabled={!e} />
          <span id="llm-limit-hint" className="text-[13px] text-muted"><span className="tnum">{used}</span> used in the last 24 hours. A spending cap: once it is reached, files are read without the external model until usage falls back under it. Use 0 to stop all external calls.</span>
        </div>
        {limNum === null && <p role="alert" className="text-[12.5px]" style={{ color: "var(--red-fg)" }}>Enter a whole number from 0 to 100000.</p>}
      </div>
      <div className="flex items-center gap-3">
        <button className="btn btn-primary btn-sm" disabled={!dirty || pending}
          onClick={async () => { if (e && !external && !(await confirm({ title: "Send file excerpts to an external AI provider?", message: "Sensitive identifiers are masked first, and people still review every result. You can turn this off at any time.", confirmLabel: "Allow" }))) return; setMsg(null); start(async () => { const r = await safely(() => updateTenantSettingsAction(a, e, limNum ?? limit)); if (r.ok) toast("Settings saved"); setMsg(r.ok ? null : { ok: false, text: r.error }); }); }}>
          <ShieldCheck size={13} aria-hidden /> {pending ? "Saving…" : "Save"}
        </button>
        {msg && <span role={msg.ok ? "status" : "alert"} className="text-[12.5px]" style={{ color: msg.ok ? "var(--green-fg)" : "var(--red-fg)" }}>{msg.text}</span>}
      </div>
    </div>
  );
}
