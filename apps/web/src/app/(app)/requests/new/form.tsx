"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, X, Search } from "lucide-react";
import { DATA_TYPES, DATA_TYPE_LABELS, PRIORITIES, type DataType } from "@taxops/core";
import { createRequestAction, updateDraftAction } from "../actions";
import { cn } from "@/components/ui";

type Option = { id: string; label: string; sub?: string };
type Kind = "department" | "entity" | "user";
interface Item { title: string; description: string; dataType: DataType; required: boolean }

const KIND_LABEL: Record<Kind, string> = { department: "Departments", entity: "Subsidiaries", user: "People" };

export interface RequestDraft {
  title: string; description: string; taxYear: number; dueDate: string; priority: (typeof PRIORITIES)[number];
  items: Item[]; assignees: { type: Kind; id: string; label: string }[];
}

export function NewRequestForm({ year, departments, entities, people, requestId, initial }: {
  year: number; departments: Option[]; entities: Option[]; people: Option[]; requestId?: string; initial?: RequestDraft;
}) {
  const editing = !!requestId;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [taxYear, setTaxYear] = useState(String(initial?.taxYear ?? year));
  const [dueDate, setDueDate] = useState(initial?.dueDate ?? "");
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>(initial?.priority ?? "medium");
  const [items, setItems] = useState<Item[]>(initial?.items.length ? initial.items : [{ title: "", description: "", dataType: "trial_balance", required: true }]);
  const [picked, setPicked] = useState<Record<string, { kind: Kind; id: string; label: string }>>(
    Object.fromEntries((initial?.assignees ?? []).map((a) => [`${a.type}:${a.id}`, { kind: a.type, id: a.id, label: a.label }])));
  const [kind, setKind] = useState<Kind>("department");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const options = useMemo(() => {
    const src = kind === "department" ? departments : kind === "entity" ? entities : people;
    const q = filter.trim().toLowerCase();
    return q ? src.filter((o) => (o.label + " " + (o.sub ?? "")).toLowerCase().includes(q)) : src;
  }, [kind, filter, departments, entities, people]);

  const toggle = (o: Option) => setPicked((p) => {
    const key = `${kind}:${o.id}`;
    const next = { ...p };
    if (next[key]) delete next[key]; else next[key] = { kind, id: o.id, label: o.label };
    return next;
  });
  const setItem = (i: number, patch: Partial<Item>) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  function submit(publish: boolean) {
    setError(null); setFieldErrors({});
    start(async () => {
      const payload = {
        title, description, taxYear, dueDate, priority,
        items: items.filter((i) => i.title.trim()),
        assignees: Object.values(picked).map((p) => ({ type: p.kind, id: p.id })),
      };
      const res = editing ? await updateDraftAction(requestId!, payload, publish) : await createRequestAction(payload, publish);
      if (!res.ok) { setError(res.error); setFieldErrors(res.fieldErrors ?? {}); return; }
      const { id, publishError } = res.data!;
      router.push(`/requests/${id}${publishError ? `?notice=${encodeURIComponent("Saved as a draft. " + publishError)}` : ""}`);
    });
  }

  const fe = (k: string) => fieldErrors[k] ? <p className="err" role="alert">{fieldErrors[k]}</p> : null;

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(false); }} className="grid gap-5 lg:grid-cols-[1fr_380px]" noValidate>
      <div className="space-y-5">
        <section className="rounded-xl border border-line bg-surface p-5" style={{ boxShadow: "var(--shadow)" }}>
          <h2 className="mb-4 text-[14px] font-semibold text-ink">Details</h2>
          <div className="space-y-4">
            <div>
              <label className="label" htmlFor="title">Title</label>
              <input id="title" className="field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. FY2025 year-end trial balances" maxLength={200} aria-invalid={!!fieldErrors.title} />
              {fe("title")}
            </div>
            <div>
              <label className="label" htmlFor="desc">Instructions <span className="font-normal text-muted">(optional)</span></label>
              <textarea id="desc" className="field" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What should contributors provide, in what format, and what basis?" maxLength={5000} />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="label" htmlFor="year">Tax year</label>
                <input id="year" className="field tnum" inputMode="numeric" value={taxYear} onChange={(e) => setTaxYear(e.target.value)} />
                {fe("taxYear")}
              </div>
              <div>
                <label className="label" htmlFor="due">Due date</label>
                <input id="due" type="date" className="field" value={dueDate} onChange={(e) => setDueDate(e.target.value)} aria-invalid={!!fieldErrors.dueDate} />
                {fe("dueDate")}
              </div>
              <div>
                <label className="label" htmlFor="prio">Priority</label>
                <select id="prio" className="field" value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}>
                  {PRIORITIES.map((p) => <option key={p} value={p}>{p[0]!.toUpperCase() + p.slice(1)}</option>)}
                </select>
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-line bg-surface p-5" style={{ boxShadow: "var(--shadow)" }}>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-[14px] font-semibold text-ink">Information items</h2>
              <p className="hint">Each item is reviewed and approved separately.</p>
            </div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setItems((xs) => [...xs, { title: "", description: "", dataType: "other", required: true }])}>
              <Plus size={14} aria-hidden /> Add item
            </button>
          </div>
          <ol className="space-y-3">
            {items.map((it, i) => (
              <li key={i} className="rounded-lg border border-line bg-surface2 p-3">
                <div className="flex items-start gap-2">
                  <span className="tnum mt-2 w-5 flex-none text-[12px] text-muted">{i + 1}.</span>
                  <div className="grid flex-1 gap-2 sm:grid-cols-[1fr_200px]">
                    <div>
                      <input aria-label={`Item ${i + 1} title`} className="field" value={it.title} onChange={(e) => setItem(i, { title: e.target.value })} placeholder="What do you need?" maxLength={200} />
                      {fe(`items.${i}.title`)}
                    </div>
                    <select aria-label={`Item ${i + 1} data type`} className="field" value={it.dataType} onChange={(e) => setItem(i, { dataType: e.target.value as DataType })}>
                      {DATA_TYPES.map((t) => <option key={t} value={t}>{DATA_TYPE_LABELS[t]}</option>)}
                    </select>
                    <input aria-label={`Item ${i + 1} notes`} className="field sm:col-span-2" value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} placeholder="Notes for the contributor (optional)" maxLength={2000} />
                    <label className="flex items-center gap-2 text-[12.5px] text-muted">
                      <input type="checkbox" checked={it.required} onChange={(e) => setItem(i, { required: e.target.checked })} /> Required
                    </label>
                  </div>
                  <button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove item ${i + 1}`} onClick={() => setItems((xs) => xs.filter((_, j) => j !== i))} disabled={items.length === 1}>
                    <Trash2 size={14} aria-hidden />
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <aside className="space-y-5">
        <section className="rounded-xl border border-line bg-surface p-5" style={{ boxShadow: "var(--shadow)" }}>
          <h2 className="text-[14px] font-semibold text-ink">Assign to</h2>
          <p className="hint mb-3">Departments, subsidiaries or individuals. Anyone in an assigned group can respond.</p>

          {Object.keys(picked).length > 0 && (
            <ul className="mb-3 flex flex-wrap gap-1.5" aria-label="Selected assignees">
              {Object.entries(picked).map(([key, p]) => (
                <li key={key}>
                  <button type="button" onClick={() => setPicked((x) => { const n = { ...x }; delete n[key]; return n; })}
                    className="inline-flex items-center gap-1.5 rounded-md bg-accentsoft px-2 py-1 text-[12px] font-medium text-accent" aria-label={`Remove ${p.label}`}>
                    {p.label} <X size={12} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {fe("assignees")}

          <div role="tablist" aria-label="Assignee type" className="mb-2 flex gap-1 rounded-lg bg-surface2 p-1">
            {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => { setKind(k); setFilter(""); }}
                className={cn("flex-1 rounded-md px-2 py-1 text-[12.5px] font-medium", kind === k ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink")}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <div className="relative mb-2">
            <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
            <input className="field !pl-8" placeholder={`Search ${KIND_LABEL[kind].toLowerCase()}`} aria-label="Search assignees" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <ul className="max-h-64 overflow-y-auto rounded-lg border border-line">
            {options.length === 0 && <li className="px-3 py-4 text-center text-[12.5px] text-muted">No matches</li>}
            {options.map((o) => {
              const on = !!picked[`${kind}:${o.id}`];
              return (
                <li key={o.id} className="border-b border-line last:border-0">
                  <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 hover:bg-surface2">
                    <input type="checkbox" checked={on} onChange={() => toggle(o)} />
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] text-ink">{o.label}</span>
                      {o.sub && <span className="block truncate text-[11.5px] text-muted">{o.sub}</span>}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </section>

        {error && <p role="alert" className="rounded-lg px-3 py-2 text-[13px]" style={{ background: "var(--red-bg)", color: "var(--red-fg)" }}>{error}</p>}
        <div className="flex gap-2">
          <button type="button" className="btn btn-primary flex-1" disabled={pending} onClick={() => submit(true)}>{pending ? "Saving…" : editing ? "Save & publish" : "Publish request"}</button>
          <button type="submit" className="btn btn-secondary" disabled={pending}>{editing ? "Save changes" : "Save draft"}</button>
        </div>
        <p className="hint">Drafts are only visible to tax staff. Publishing opens the request for submissions from the people you assigned.</p>
      </aside>
    </form>
  );
}
