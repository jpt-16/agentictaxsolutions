"use client";
import { useState, useTransition } from "react";
import { Check, Send, X } from "lucide-react";
import { useConfirm, useToast } from "@/components/overlays";
import { decideProposalAction, sendBackAction } from "../actions";

export function DecisionForm({ proposalId, kind }: { proposalId: string; kind: "extraction" | "finding" }) {
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);
  const finding = kind === "finding";
  const go = (decision: "accepted" | "rejected") => {
    setError(null);
    start(async () => { const r = await decideProposalAction(proposalId, decision, note); if (!r.ok) setError(r.error); });
  };
  return (
    <div className="px-5 py-4">
      <label className="label" htmlFor="decision-note">Your decision</label>
      <textarea id="decision-note" className="field" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000}
        placeholder={finding ? "Optional when confirming. Required when dismissing: why is this not an issue?" : "Optional when accepting. Required when rejecting: say what is wrong so the data can be corrected."} />
      <div className="mt-3 flex flex-col gap-2">
        <button className="btn btn-primary" disabled={pending} onClick={() => go("accepted")}><Check size={14} aria-hidden /> {finding ? "Confirm this is an issue" : "Accept as correctly read"}</button>
        {!confirmReject ? (
          <button className="btn btn-secondary" disabled={pending} onClick={() => setConfirmReject(true)}><X size={14} aria-hidden /> {finding ? "Dismiss…" : "Reject…"}</button>
        ) : (
          <button className="btn btn-danger" disabled={pending || note.trim().length < 3} onClick={() => go("rejected")}>
            <X size={14} aria-hidden /> {note.trim().length < 3 ? `Enter a reason to ${finding ? "dismiss" : "reject"}` : `Confirm ${finding ? "dismissal" : "rejection"}`}
          </button>
        )}
      </div>
      {error && <p role="alert" className="mt-2 text-[12.5px]" style={{ color: "var(--red-fg)" }}>{error}</p>}
      <p className="hint mt-3">Decisions are final and recorded in the audit history with your name.</p>
    </div>
  );
}

export function SendBack({ findingId }: { findingId: string }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="px-5 py-4">
      <button className="btn btn-primary w-full" disabled={pending} onClick={async () => { if (await confirm({ title: "Send back to contributor?", message: "This finding becomes the reason, and they are asked to resubmit.", confirmLabel: "Send back" })) { setError(null); start(async () => { const r = await sendBackAction(findingId); if (!r.ok) setError(r.error); else toast("Sent back to contributor"); }); } }}>
        <Send size={14} aria-hidden /> {pending ? "Sending…" : "Send back to contributor"}
      </button>
      {error && <p role="alert" className="mt-2 text-[12.5px]" style={{ color: "var(--red-fg)" }}>{error}</p>}
      <p className="hint mt-2">Requests changes on the item using this finding as the reason. The contributor is asked to resubmit.</p>
    </div>
  );
}
