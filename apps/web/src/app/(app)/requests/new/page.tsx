import { notFound } from "next/navigation";
import { assertCan, can } from "@taxops/core";
import Link from "next/link";
import { getTemplate, listDirectory, listTemplates, NotFoundError } from "@taxops/services";
import { requireContext } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { NewRequestForm } from "./form";

export const metadata = { title: "New request" };
export const dynamic = "force-dynamic";

export default async function NewRequestPage({ searchParams }: { searchParams: Promise<{ template?: string }> }) {
  const ctx = await requireContext();
  if (!can(ctx.session.role, "request.create")) notFound();
  const sp = await searchParams;
  const dir = await listDirectory(ctx);
  const templates = await listTemplates(ctx);
  let initial;
  if (sp.template && /^[0-9a-f-]{36}$/i.test(sp.template)) {
    try {
      const t = await getTemplate(ctx, sp.template);
      initial = { title: t.name, description: t.description, taxYear: new Date().getUTCFullYear() - 1, dueDate: "", priority: "medium" as const, items: t.items, assignees: [] };
    } catch (e) { if (!(e instanceof NotFoundError)) throw e; }
  }
  return (
    <>
      <PageHeader title="New information request" subtitle="Describe what you need, who should provide it, and by when."
        crumbs={[{ href: "/requests", label: "Information requests" }, { label: "New" }]} />
      {templates.length > 0 && (
        <nav aria-label="Start from a template" className="mb-5 flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-muted">Start from a template:</span>
          <div className="segmented">
            {templates.map((t) => <Link key={t.id} href={`/requests/new?template=${t.id}`} aria-current={sp.template === t.id ? "page" : undefined}>{t.name} · {t.itemCount}</Link>)}
          </div>
        </nav>
      )}
      <NewRequestForm
        key={sp.template ?? "blank"}
        initial={initial}
        year={new Date().getUTCFullYear() - 1}
        departments={dir.departments.map((d) => ({ id: d.id, label: d.name, sub: d.code }))}
        entities={dir.entities.map((e) => ({ id: e.id, label: e.name, sub: `${e.country} · ${e.currency}` }))}
        people={dir.users.filter((u) => u.role === "contributor").map((u) => ({ id: u.id, label: u.name, sub: u.title }))}
      />
    </>
  );
}
