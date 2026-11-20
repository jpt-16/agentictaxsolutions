"use client";
import { useState, useTransition } from "react";
import { Check, X } from "lucide-react";
import { decideProposalAction } from "../actions";

export function DecisionForm({ proposalId }: { proposalId: string }) {
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);
  const go = (decision: "accepted" | "rejected") => {
    setError(null);
    start(async () => { const r = await decideProposalAction(proposalId, decision, note); if (!r.ok) setError(r.error); });
  };
  return (
    <div className="px-5 py-4">
      <label className="label" htmlFor="decision-note">Your decision</label>
      <textarea id="decision-note" className="field" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000}
        placeholder="Optional when accepting. Required when rejecting: say what is wrong so the data can be corrected." />
      <div className="mt-3 flex flex-col gap-2">
        <button className="btn btn-primary" disabled={pending} onClick={() => go("accepted")}><Check size={14} aria-hidden /> Accept as correctly read</button>
        {!confirmReject ? (
          <button className="btn btn-secondary" disabled={pending} onClick={() => setConfirmReject(true)}><X size={14} aria-hidden /> Reject…</button>
        ) : (
          <button className="btn btn-danger" disabled={pending || note.trim().length < 3} onClick={() => go("rejected")}>
            <X size={14} aria-hidden /> {note.trim().length < 3 ? "Enter a reason to reject" : "Confirm rejection"}
          </button>
        )}
      </div>
      {error && <p role="alert" className="mt-2 text-[12.5px]" style={{ color: "var(--red-fg)" }}>{error}</p>}
      <p className="hint mt-3">Decisions are final and recorded in the audit history with your name.</p>
    </div>
  );
}
