"use client";
import { useState, useTransition } from "react";
import { Building2 } from "lucide-react";
import { useToast } from "@/components/overlays";
import { setProposalEntityAction } from "../actions";
import { safely } from "@/lib/safe-action";

export interface EntityOption { id: string; code: string; name: string }
const SOURCE: Record<string, string> = { assignment: "the request's assignment", uploader: "who uploaded the file", file: "text in the file", reviewer: "a reviewer's choice" };

/**
 * Whose books is this trial balance? Shows the stored choice or the suggestion with the evidence behind it. While the result is pending a
 * reviewer can pick another entity. Accepting the result confirms whatever is shown; when the evidence conflicts or is missing,
 * accepting is refused until an entity is chosen here.
 */
export function EntityPanel({ proposalId, canEdit, chosen, status, note, suggestion, options }: {
  proposalId: string; canEdit: boolean;
  chosen: { id: string; label: string; source: string } | null;
  status: "suggested" | "conflict" | "unknown";
  note: string;
  suggestion: { id: string; label: string; source: string } | null;
  options: EntityOption[];
}) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const current = chosen ?? (status === "suggested" ? suggestion : null);
  const [value, setValue] = useState<string>(chosen?.id ?? (status === "suggested" ? suggestion?.id ?? "" : ""));
  const needsChoice = !chosen && status !== "suggested";
  const dirty = value !== (chosen?.id ?? "") && value !== "";
  const save = () => { setError(null); start(async () => { const r = await safely(() => setProposalEntityAction(proposalId, value)); if (!r.ok) setError(r.error); else toast("Entity saved"); }); };

  return (
    <div className="px-5 py-4 text-[13.5px]">
      <p className="flex items-start gap-2 text-ink">
        <Building2 size={15} className="mt-0.5 flex-none text-muted" aria-hidden />
        <span>
          {current ? <><strong>{current.label}</strong><span className="block text-[12.5px] text-muted">{chosen ? `Confirmed: ${SOURCE[chosen.source] ?? chosen.source}` : `Suggested from ${SOURCE[current.source] ?? current.source}. Accepting this result confirms it.`}</span></>
            : <strong>Not known yet</strong>}
        </span>
      </p>
      {needsChoice && <p role="alert" className="mt-2 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: "var(--amber-bg)", color: "var(--amber-fg)" }}>{note}</p>}
      {!needsChoice && !chosen && <p className="mt-2 text-[12.5px] text-muted">{note}</p>}
      {canEdit && (
        <div className="mt-3">
          <label className="label" htmlFor="entity-select">{chosen || current ? "Change entity" : "Choose the entity"}</label>
          <div className="flex gap-2">
            <select id="entity-select" className="field" value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="">Select an entity…</option>
              {options.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.code})</option>)}
            </select>
            <button className="btn btn-secondary" disabled={pending || !dirty} onClick={save}>{pending ? "Saving…" : "Save"}</button>
          </div>
          {error && <p role="alert" className="mt-2 text-[12.5px]" style={{ color: "var(--red-fg)" }}>{error}</p>}
        </div>
      )}
    </div>
  );
}
