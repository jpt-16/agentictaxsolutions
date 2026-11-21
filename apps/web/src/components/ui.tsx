import clsx from "clsx";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  ITEM_STATUS_LABELS, REQUEST_STATUS_LABELS, confidenceBand, type ItemStatus, type Priority, type RequestStatus,
} from "@taxops/core";

export const cn = clsx;

/* ---------- formatting (UTC so server and client always agree) ---------- */
const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const dateTimeFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
export const formatDate = (iso: string) => dateFmt.format(new Date(`${iso}T00:00:00Z`));
export const formatDateTime = (d: Date | string) => `${dateTimeFmt.format(new Date(d))} UTC`;

export function dueLabel(daysLeft: number, overdue: boolean): string {
  if (overdue) return `${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? "" : "s"} overdue`;
  if (daysLeft === 0) return "Due today";
  if (daysLeft === 1) return "Due tomorrow";
  return `${daysLeft} days left`;
}

/* ---------- badges ---------- */
type Tone = "slate" | "blue" | "indigo" | "violet" | "amber" | "green" | "red" | "zinc";

export function Badge({ tone = "slate", dot, children }: { tone?: Tone; dot?: boolean; children: ReactNode }) {
  return <span className={cn("badge", `tone-${tone}`)}>{dot && <span className="dot" aria-hidden />}{children}</span>;
}

const REQUEST_TONE: Record<RequestStatus, Tone> = {
  draft: "slate", open: "blue", in_progress: "indigo", changes_requested: "amber", in_review: "violet", approved: "green", closed: "zinc",
};
export const RequestStatusBadge = ({ status }: { status: RequestStatus }) => (
  <Badge tone={REQUEST_TONE[status]} dot>{REQUEST_STATUS_LABELS[status]}</Badge>
);

const ITEM_TONE: Record<ItemStatus, Tone> = { pending: "slate", submitted: "violet", changes_requested: "amber", approved: "green" };
export const ItemStatusBadge = ({ status }: { status: ItemStatus }) => (
  <Badge tone={ITEM_TONE[status]} dot>{ITEM_STATUS_LABELS[status]}</Badge>
);

const PRIORITY_TONE: Record<Priority, Tone> = { low: "slate", medium: "blue", high: "red" };
export const PriorityBadge = ({ priority }: { priority: Priority }) => (
  <Badge tone={PRIORITY_TONE[priority]}>{priority[0]!.toUpperCase() + priority.slice(1)}</Badge>
);

/* ---------- layout ---------- */
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn("group", className)}>{children}</section>;
}

export function CardHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-4 sm:px-5">
      <div>
        <h2 className="t-head text-ink">{title}</h2>
        {subtitle && <p className="mt-0.5 text-[12.5px] text-muted">{subtitle}</p>}
      </div>
      {action}
    </header>
  );
}

export function PageHeader({ title, subtitle, actions, crumbs }: {
  title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; crumbs?: { href?: string; label: string }[];
}) {
  return (
    <div className="mb-6 sm:mb-8">
      {crumbs && (
        <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-1.5 text-[12.5px] text-muted">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && <span aria-hidden>/</span>}
              {c.href ? <Link href={c.href} className="hover:text-ink">{c.label}</Link> : <span>{c.label}</span>}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 data-large-title className="t-large text-ink">{title}</h1>
          {subtitle && <p className="mt-1.5 text-[15px] text-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function EmptyState({ title, body, action, icon }: { title: string; body?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      {icon && <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-surface2 text-muted">{icon}</div>}
      <p className="font-medium text-ink">{title}</p>
      {body && <p className="mt-1 max-w-sm text-[13px] text-muted">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ProgressBar({ value, max, tone = "green", label }: { value: number; max: number; tone?: "green" | "indigo"; label?: string }) {
  const pct = max === 0 ? 0 : Math.round((value / max) * 100);
  return (
    <div className="flex items-center gap-2.5">
      <div role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label ?? "Progress"}
        className="h-1.5 w-20 flex-none sm:w-24 overflow-hidden rounded-full" style={{ background: "var(--slate-bg)" }}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: tone === "green" ? "var(--bar-approved)" : "var(--bar-progress)" }} />
      </div>
      <span className="tnum text-[12px] text-muted">{value}/{max}</span>
    </div>
  );
}

export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
  return (
    <span aria-hidden className="inline-flex flex-none items-center justify-center rounded-full font-semibold"
      style={{ width: size, height: size, fontSize: size * 0.4, background: "var(--accent-soft)", color: "var(--accent-strong)" }}>
      {initials}
    </span>
  );
}

export function Chip({ children, kind }: { children: ReactNode; kind?: "department" | "entity" | "user" }) {
  const label = kind === "department" ? "Dept" : kind === "entity" ? "Entity" : kind === "user" ? "Person" : null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-surface2 px-2.5 py-0.5 text-[12px] border border-line text-body">
      {label && <span className="text-[10.5px] font-semibold uppercase tracking-wide text-subtle">{label}</span>}
      {children}
    </span>
  );
}

/** Where to look first, never a gate: a person reviews every AI result regardless of this number. */
export function ConfidencePill({ value }: { value: number }) {
  const band = confidenceBand(value);
  return <Badge tone={band === "high" ? "green" : band === "medium" ? "amber" : "red"}>{Math.round(value * 100)}% confidence</Badge>;
}

export function SeverityBadge({ severity }: { severity: "info" | "warning" | "error" | null }) {
  const tone = severity === "error" ? "red" : severity === "warning" ? "amber" : "slate";
  return <Badge tone={tone} dot>{severity === "error" ? "Error" : severity === "warning" ? "Warning" : "Info"}</Badge>;
}

/** Comment text with @mentions emphasised. Purely visual: React escapes everything, nothing is parsed as HTML. */
export function MentionText({ text }: { text: string }) {
  const parts = text.split(/(@[\p{Lu}][\p{L}'’-]*(?: [\p{Lu}][\p{L}'’-]*)?)/u);
  return <>{parts.map((p, i) => (i % 2 === 1 ? <span key={i} className="rounded px-0.5 font-medium" style={{ background: "var(--accent-soft)", color: "var(--accent-strong)" }}>{p}</span> : p))}</>;
}
