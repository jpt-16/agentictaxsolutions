"use client";
import { useState, useTransition } from "react";
import { Check, MessageSquarePlus, RotateCcw, Send } from "lucide-react";
import { addCommentAction, closeRequestAction, publishRequestAction, reviewItemAction, submitItemAction } from "../actions";

function ErrorLine({ msg }: { msg: string | null }) {
  return msg ? <p role="alert" className="mt-2 text-[12.5px]" style={{ color: "var(--red-fg)" }}>{msg}</p> : null;
}

export function RequestActions({ requestId, canPublish, canClose }: { requestId: string; canPublish: boolean; canClose: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => ReturnType<typeof publishRequestAction>, confirmMsg: string) => {
    if (!window.confirm(confirmMsg)) return;
    setError(null);
    start(async () => { const r = await fn(); if (!r.ok) setError(r.error); });
  };
  if (!canPublish && !canClose) return null;
  return (
    <div className="flex flex-col items-end">
      {canPublish && (
        <button className="btn btn-primary" disabled={pending}
          onClick={() => run(() => publishRequestAction(requestId), "Publish this request? Assignees will be able to see it and submit information.")}>
          <Send size={14} aria-hidden /> {pending ? "Publishing…" : "Publish request"}
        </button>
      )}
      {canClose && (
        <button className="btn btn-primary" disabled={pending}
          onClick={() => run(() => closeRequestAction(requestId), "Close this request? It will become read-only.")}>
          <Check size={14} aria-hidden /> {pending ? "Closing…" : "Sign off & close"}
        </button>
      )}
      <ErrorLine msg={error} />
    </div>
  );
}

export function SubmitForm({ requestId, itemId, resubmit }: { requestId: string; itemId: string; resubmit: boolean }) {
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="mt-3 rounded-lg border border-line bg-surface2 p-3"
      onSubmit={(e) => { e.preventDefault(); setError(null); start(async () => { const r = await submitItemAction(requestId, itemId, note); if (!r.ok) setError(r.error); else setNote(""); }); }}>
      <label className="label" htmlFor={`note-${itemId}`}>{resubmit ? "Resubmit with your updates" : "Submit your response"}</label>
      <textarea id={`note-${itemId}`} className="field" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000}
        placeholder="Describe what you are providing (file upload arrives in the next phase)." />
      <div className="mt-2 flex items-center justify-between">
        <span className="hint">Reviewers are told what you submit and when.</span>
        <button type="submit" className="btn btn-primary btn-sm" disabled={pending || note.trim().length < 3}>{pending ? "Submitting…" : resubmit ? "Resubmit" : "Submit"}</button>
      </div>
      <ErrorLine msg={error} />
    </form>
  );
}

export function ReviewForm({ requestId, itemId }: { requestId: string; itemId: string }) {
  const [rationale, setRationale] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const decide = (decision: "approved" | "changes_requested") => {
    setError(null);
    start(async () => { const r = await reviewItemAction(requestId, itemId, decision, rationale); if (!r.ok) setError(r.error); else setRationale(""); });
  };
  return (
    <div className="mt-3 rounded-lg border border-line bg-surface2 p-3">
      <label className="label" htmlFor={`review-${itemId}`}>Your review</label>
      <textarea id={`review-${itemId}`} className="field" value={rationale} onChange={(e) => setRationale(e.target.value)} maxLength={2000}
        placeholder="Optional when approving; required when requesting changes." />
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" className="btn btn-secondary btn-sm" disabled={pending || rationale.trim().length < 3} onClick={() => decide("changes_requested")}>
          <RotateCcw size={13} aria-hidden /> Request changes
        </button>
        <button type="button" className="btn btn-primary btn-sm" disabled={pending} onClick={() => decide("approved")}>
          <Check size={13} aria-hidden /> Approve
        </button>
      </div>
      <ErrorLine msg={error} />
    </div>
  );
}

export function CommentForm({ requestId }: { requestId: string }) {
  const [body, setBody] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="border-t border-line p-4"
      onSubmit={(e) => { e.preventDefault(); setError(null); start(async () => { const r = await addCommentAction(requestId, body); if (!r.ok) setError(r.error); else setBody(""); }); }}>
      <label className="label" htmlFor="comment">Add a comment</label>
      <textarea id="comment" className="field" value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} placeholder="Ask a question or leave a note for the team." />
      <div className="mt-2 flex justify-end">
        <button type="submit" className="btn btn-secondary btn-sm" disabled={pending || !body.trim()}><MessageSquarePlus size={13} aria-hidden /> {pending ? "Posting…" : "Post comment"}</button>
      </div>
      <ErrorLine msg={error} />
    </form>
  );
}
