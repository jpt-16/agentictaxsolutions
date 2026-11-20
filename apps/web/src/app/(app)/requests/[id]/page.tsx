import { notFound } from "next/navigation";
import Link from "next/link";
import { CalendarClock, Download, FileSpreadsheet, FileText, Info, Lock, MessageSquare, User2 } from "lucide-react";
import { DATA_TYPE_LABELS, ROLE_LABELS } from "@taxops/core";
import { getRequestDetail, NotFoundError } from "@taxops/services";
import { requireContext } from "@/lib/auth";
import {
  Avatar, Badge, Card, CardHeader, Chip, EmptyState, ItemStatusBadge, PageHeader, PriorityBadge, ProgressBar,
  RequestStatusBadge, cn, dueLabel, formatDate, formatDateTime,
} from "@/components/ui";
import { CommentForm, RequestActions, ReviewForm, SubmitForm } from "./interactive";

export const dynamic = "force-dynamic";
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  return { title: "Request" };
}

export default async function RequestPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string }>;
}) {
  const ctx = await requireContext();
  const { id } = await params;
  const { notice } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let r;
  try { r = await getRequestDetail(ctx, id); } catch (e) { if (e instanceof NotFoundError) notFound(); throw e; }
  const approved = r.items.filter((i) => i.status === "approved").length;
  const itemTitle = new Map(r.items.map((i) => [i.id, i.title]));

  return (
    <>
      <PageHeader
        crumbs={[{ href: "/requests", label: "Information requests" }, { label: r.reference }]}
        title={<span className="flex flex-wrap items-center gap-3">{r.title}</span>}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <RequestStatusBadge status={r.status} />
            <PriorityBadge priority={r.priority} />
            <span className="tnum inline-flex items-center gap-1.5"><CalendarClock size={14} aria-hidden /> Due {formatDate(r.dueDate)}
              {r.status !== "draft" && r.status !== "approved" && r.status !== "closed" && (
                <span className={cn(r.overdue && "font-medium")} style={r.overdue ? { color: "var(--red-fg)" } : undefined}> · {dueLabel(r.daysLeft, r.overdue)}</span>
              )}
            </span>
            <span className="tnum">{r.reference} · FY{r.taxYear}</span>
            <span className="inline-flex items-center gap-1.5"><User2 size={14} aria-hidden /> Created by {r.createdByName}</span>
          </span>
        }
        actions={<RequestActions requestId={r.id} canPublish={r.can.publish} canClose={r.can.close} />}
      />

      {notice && (
        <p role="status" className="mb-4 flex items-start gap-2 rounded-lg px-3.5 py-2.5 text-[13px]" style={{ background: "var(--amber-bg)", color: "var(--amber-fg)" }}>
          <Info size={16} className="mt-0.5 flex-none" aria-hidden /> {notice.slice(0, 300)}
        </p>
      )}
      {r.status === "draft" && (
        <p className="mb-4 flex items-start gap-2 rounded-lg px-3.5 py-2.5 text-[13px]" style={{ background: "var(--slate-bg)", color: "var(--slate-fg)" }}>
          <Lock size={16} className="mt-0.5 flex-none" aria-hidden /> This is a draft. Only tax staff can see it until it is published.
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="space-y-5">
          {r.description && (
            <Card>
              <CardHeader title="Instructions" />
              <p className="whitespace-pre-wrap px-5 py-4 text-[14px] text-body">{r.description}</p>
            </Card>
          )}

          <Card>
            <CardHeader title="Information items" subtitle={`${approved} of ${r.items.length} approved`} />
            {r.items.length === 0 ? <EmptyState title="No items yet" body="This request has no information items." /> : (
              <ol className="divide-y divide-line">
                {r.items.map((it) => (
                  <li key={it.id} id={`item-${it.id}`} className="scroll-mt-20 px-5 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium text-ink"><span className="tnum mr-1.5 text-muted">{it.position}.</span>{it.title}</p>
                        <p className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-muted">
                          <Badge tone="slate">{DATA_TYPE_LABELS[it.dataType]}</Badge>
                          {it.required ? <span>Required</span> : <span>Optional</span>}
                        </p>
                        {it.description && <p className="mt-2 text-[13px] text-body">{it.description}</p>}
                      </div>
                      <ItemStatusBadge status={it.status} />
                    </div>

                    {it.submissions.length > 0 && (
                      <ul className="mt-3 space-y-2">
                        {it.submissions.map((s) => (
                          <li key={s.id} className="rounded-lg border border-line px-3 py-2.5">
                            <p className="flex flex-wrap items-center gap-x-2 text-[12px] text-muted">
                              <Badge tone="indigo">v{s.version}</Badge>
                              <span className="font-medium text-ink">{s.submitterName}</span>
                              <span>{formatDateTime(s.createdAt)}</span>
                            </p>
                            <p className="mt-1.5 whitespace-pre-wrap text-[13px] text-body">{s.note}</p>
                            {s.files.length > 0 && (
                              <ul className="mt-2 space-y-1.5" aria-label={`Files in version ${s.version}`}>
                                {s.files.map((f) => (
                                  <li key={f.id} className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface2 px-2.5 py-1.5 text-[12.5px]">
                                    <span className="flex min-w-0 items-center gap-2 text-ink">
                                      {f.previewable ? <FileSpreadsheet size={15} aria-hidden className="flex-none text-muted" /> : <FileText size={15} aria-hidden className="flex-none text-muted" />}
                                      <span className="truncate font-medium">{f.name}</span>
                                      <span className="tnum flex-none text-muted">{f.size < 1048576 ? `${Math.max(1, Math.round(f.size / 1024))} KB` : `${(f.size / 1048576).toFixed(1)} MB`}</span>
                                    </span>
                                    <span className="flex flex-none items-center gap-1">
                                      {f.previewable && <Link className="btn btn-ghost btn-sm" href={`/requests/${r.id}/files/${f.id}`}>View</Link>}
                                      <a className="btn btn-ghost btn-sm" href={`/api/files/${f.id}`} aria-label={`Download ${f.name}`}><Download size={13} aria-hidden /></a>
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            )}
                            {s.review && (
                              <p className="mt-2 rounded-md px-2.5 py-1.5 text-[12.5px]"
                                style={s.review.decision === "approved"
                                  ? { background: "var(--green-bg)", color: "var(--green-fg)" }
                                  : { background: "var(--amber-bg)", color: "var(--amber-fg)" }}>
                                <strong>{s.review.decision === "approved" ? "Approved" : "Changes requested"}</strong> by {s.review.reviewerName}
                                {s.review.rationale ? ` — ${s.review.rationale}` : ""}
                              </p>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}

                    {it.can.submit && <SubmitForm requestId={r.id} itemId={it.id} resubmit={it.status === "changes_requested"} />}
                    {it.can.review && <ReviewForm requestId={r.id} itemId={it.id} />}
                    {it.reviewBlockedBySod && (
                      <p className="mt-3 flex items-start gap-2 text-[12.5px] text-muted"><Lock size={14} className="mt-0.5 flex-none" aria-hidden />
                        You submitted this item, so someone else must review it (segregation of duties).</p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </Card>

          <Card>
            <CardHeader title="Discussion" subtitle={`${r.comments.length} comment${r.comments.length === 1 ? "" : "s"}`} />
            {r.comments.length === 0 ? (
              <EmptyState icon={<MessageSquare size={18} />} title="No comments yet" body="Questions and clarifications about this request appear here." />
            ) : (
              <ul className="divide-y divide-line">
                {r.comments.map((c) => (
                  <li key={c.id} className="flex gap-3 px-5 py-3.5">
                    <Avatar name={c.authorName} size={30} />
                    <div className="min-w-0">
                      <p className="text-[12.5px] text-muted"><span className="font-medium text-ink">{c.authorName}</span> · {ROLE_LABELS[c.authorRole]} · {formatDateTime(c.createdAt)}
                        {c.itemId && itemTitle.get(c.itemId) && <> · on “{itemTitle.get(c.itemId)}”</>}</p>
                      <p className="mt-0.5 whitespace-pre-wrap text-[13.5px] text-body">{c.body}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {r.can.comment && <CommentForm requestId={r.id} />}
          </Card>
        </div>

        <aside className="space-y-5">
          <Card>
            <CardHeader title="Progress" />
            <div className="px-5 py-4">
              <p className="tnum text-[26px] font-semibold leading-none text-ink">{r.items.length ? Math.round((approved / r.items.length) * 100) : 0}%</p>
              <p className="mb-3 mt-1 text-[12.5px] text-muted">of items approved</p>
              <ProgressBar value={approved} max={r.items.length} label="Items approved" />
            </div>
          </Card>

          <Card>
            <CardHeader title="Assigned to" />
            <div className="flex flex-wrap gap-1.5 px-5 py-4">
              {r.assignees.length === 0 ? <span className="text-[13px] text-muted">No one yet</span>
                : r.assignees.map((a) => <Chip key={a.type + a.id} kind={a.type}>{a.label}</Chip>)}
            </div>
          </Card>

          <Card>
            <CardHeader title="Activity" subtitle="Everything that has happened on this request" />
            {r.activity.length === 0 ? <EmptyState title="No activity yet" /> : (
              <ol className="max-h-[420px] overflow-y-auto px-5 py-3">
                {r.activity.map((e) => (
                  <li key={e.id} className="relative border-l border-line pb-4 pl-4 last:pb-1">
                    <span aria-hidden className="absolute -left-[4.5px] top-1.5 h-2 w-2 rounded-full" style={{ background: "var(--line-strong)" }} />
                    <p className="text-[13px] text-ink">{e.summary}</p>
                    <p className="text-[12px] text-muted">{e.actorLabel} · {formatDateTime(e.occurredAt)}</p>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </aside>
      </div>
    </>
  );
}
