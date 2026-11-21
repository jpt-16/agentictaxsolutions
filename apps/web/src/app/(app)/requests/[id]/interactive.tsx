"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, MessageSquarePlus, Paperclip, RotateCcw, Send, X } from "lucide-react";
import { useConfirm, useToast } from "@/components/overlays";
import { addCommentAction, closeRequestAction, publishRequestAction, reviewItemAction } from "../actions";

function ErrorLine({ msg }: { msg: string | null }) {
  return msg ? <p role="alert" className="mt-2 text-[12.5px]" style={{ color: "var(--red-fg)" }}>{msg}</p> : null;
}

export function RequestActions({ requestId, canPublish, canClose }: { requestId: string; canPublish: boolean; canClose: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const toast = useToast();
  const run = async (fn: () => ReturnType<typeof publishRequestAction>, o: { title: string; message: string; confirmLabel: string; done: string }) => {
    if (!(await confirm({ title: o.title, message: o.message, confirmLabel: o.confirmLabel }))) return;
    setError(null);
    start(async () => { const r = await fn(); if (!r.ok) setError(r.error); else toast(o.done); });
  };
  if (!canPublish && !canClose) return null;
  return (
    <div className="flex flex-col items-end">
      {canPublish && (
        <button className="btn btn-primary" disabled={pending}
          onClick={() => run(() => publishRequestAction(requestId), { title: "Publish this request?", message: "Assignees will be able to see it and submit information.", confirmLabel: "Publish", done: "Request published" })}>
          <Send size={14} aria-hidden /> {pending ? "Publishing…" : "Publish request"}
        </button>
      )}
      {canClose && (
        <button className="btn btn-primary" disabled={pending}
          onClick={() => run(() => closeRequestAction(requestId), { title: "Sign off and close?", message: "The request becomes read-only.", confirmLabel: "Close request", done: "Request closed" })}>
          <Check size={14} aria-hidden /> {pending ? "Closing…" : "Sign off & close"}
        </button>
      )}
      <ErrorLine msg={error} />
    </div>
  );
}

const ACCEPT = ".xlsx,.csv,.pdf,.docx,.txt,.png,.jpg,.jpeg";
const fmt = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function SubmitForm({ requestId, itemId, resubmit }: { requestId: string; itemId: string; resubmit: boolean }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<File[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<{ file: string; reason: string }[]>([]);
  const input = useRef<HTMLInputElement>(null);

  function addFiles(list: FileList | null) {
    if (!list) return;
    // Copy BEFORE resetting the input: clearing `value` empties the live FileList, and state updaters run later.
    const added = Array.from(list);
    setPicked((cur) => [...cur, ...added].slice(0, 10));
    if (input.current) input.current.value = "";
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setReasons([]); setPending(true);
    try {
      const form = new FormData();
      form.set("itemId", itemId); form.set("requestId", requestId); form.set("note", note);
      picked.forEach((f) => form.append("files", f));
      const res = await fetch("/api/submissions", { method: "POST", body: form });
      const json = await res.json().catch(() => ({ ok: false, error: "Unexpected response from the server." }));
      if (!json.ok) { setError(json.error); setReasons(json.reasons ?? []); return; }
      setNote(""); setPicked([]); router.refresh();
    } catch { setError("The upload could not be completed. Check your connection and try again."); }
    finally { setPending(false); }
  }

  return (
    <form className="mt-3 rounded-lg border border-line bg-surface2 p-3" onSubmit={submit}>
      <label className="label" htmlFor={`note-${itemId}`}>{resubmit ? "Resubmit with your updates" : "Submit your response"}</label>
      <textarea id={`note-${itemId}`} className="field" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000}
        placeholder="Describe what you are providing (basis, period, anything the reviewer should know)." />

      <div className="mt-2.5">
        <input ref={input} id={`files-${itemId}`} type="file" multiple accept={ACCEPT} className="sr-only" onChange={(e) => addFiles(e.target.files)} />
        <label htmlFor={`files-${itemId}`} className="btn btn-secondary btn-sm cursor-pointer"><Paperclip size={13} aria-hidden /> Attach files</label>
        <span className="hint ml-2">xlsx, csv, pdf, docx, txt, png, jpg · up to 25 MB each · scanned for malware</span>
        {picked.length > 0 && (
          <ul className="mt-2 space-y-1" aria-label="Files to upload">
            {picked.map((f, i) => (
              <li key={i} className="flex items-center justify-between gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12.5px]">
                <span className="min-w-0 truncate text-ink">{f.name} <span className="text-muted">· {fmt(f.size)}</span></span>
                <button type="button" className="text-muted hover:text-ink" aria-label={`Remove ${f.name}`} onClick={() => setPicked((c) => c.filter((_, j) => j !== i))}><X size={13} aria-hidden /></button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-3 flex items-center justify-end">
        <button type="submit" className="btn btn-primary btn-sm" disabled={pending || note.trim().length < 3}>
          {pending ? (picked.length ? "Scanning & uploading…" : "Submitting…") : resubmit ? "Resubmit" : "Submit"}
        </button>
      </div>
      <ErrorLine msg={error} />
      {reasons.length > 1 && (
        <ul className="mt-1 list-disc pl-5 text-[12.5px]" style={{ color: "var(--red-fg)" }}>
          {reasons.map((r, i) => <li key={i}><strong>{r.file}</strong>: {r.reason}</li>)}
        </ul>
      )}
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
