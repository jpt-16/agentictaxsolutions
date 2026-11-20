"use client";
import { useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { reprocessFileAction } from "./actions";

export function ReprocessButton({ fileId, requestId, small = true }: { fileId: string; requestId: string; small?: boolean }) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <button className={`btn btn-ghost ${small ? "btn-sm" : ""}`} disabled={pending || state === "queued"} title="Queue AI processing again for this file"
        onClick={() => start(async () => { const r = await reprocessFileAction(fileId, requestId); setState(r.ok ? "queued" : r.error); })}>
        <RefreshCw size={13} aria-hidden /> {state === "queued" ? "Queued" : "Re-run"}
      </button>
      {state && state !== "queued" && <span role="alert" className="text-[12px]" style={{ color: "var(--red-fg)" }}>{state}</span>}
    </span>
  );
}
