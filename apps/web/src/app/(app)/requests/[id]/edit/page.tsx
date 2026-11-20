import { notFound, redirect } from "next/navigation";
import { can } from "@taxops/core";
import { getRequestDetail, listDirectory, NotFoundError } from "@taxops/services";
import { requireContext } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { NewRequestForm } from "../../new/form";

export const metadata = { title: "Edit draft" };
export const dynamic = "force-dynamic";

export default async function EditDraftPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireContext();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !can(ctx.session.role, "request.update")) notFound();
  let r;
  try { r = await getRequestDetail(ctx, id); } catch (e) { if (e instanceof NotFoundError) notFound(); throw e; }
  if (r.status !== "draft") redirect(`/requests/${id}`); // published requests are read-only
  const dir = await listDirectory(ctx);
  return (
    <>
      <PageHeader title={`Edit draft ${r.reference}`} subtitle="Drafts can be changed freely. Once published, a request is read-only."
        crumbs={[{ href: "/requests", label: "Information requests" }, { href: `/requests/${id}`, label: r.reference }, { label: "Edit" }]} />
      <NewRequestForm
        year={r.taxYear} requestId={id}
        departments={dir.departments.map((d) => ({ id: d.id, label: d.name, sub: d.code }))}
        entities={dir.entities.map((e) => ({ id: e.id, label: e.name, sub: `${e.country} · ${e.currency}` }))}
        people={dir.users.filter((u) => u.role === "contributor").map((u) => ({ id: u.id, label: u.name, sub: u.title }))}
        initial={{
          title: r.title, description: r.description, taxYear: r.taxYear, dueDate: r.dueDate, priority: r.priority,
          items: r.items.map((i) => ({ title: i.title, description: i.description, dataType: i.dataType, required: i.required })),
          assignees: r.assignees,
        }}
      />
    </>
  );
}
