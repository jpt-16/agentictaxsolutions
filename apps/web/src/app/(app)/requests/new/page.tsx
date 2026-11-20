import { notFound } from "next/navigation";
import { assertCan, can } from "@taxops/core";
import { listDirectory } from "@taxops/services";
import { requireContext } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { NewRequestForm } from "./form";

export const metadata = { title: "New request" };
export const dynamic = "force-dynamic";

export default async function NewRequestPage() {
  const ctx = await requireContext();
  if (!can(ctx.session.role, "request.create")) notFound();
  const dir = await listDirectory(ctx);
  return (
    <>
      <PageHeader title="New information request" subtitle="Describe what you need, who should provide it, and by when."
        crumbs={[{ href: "/requests", label: "Information requests" }, { label: "New" }]} />
      <NewRequestForm
        year={new Date().getUTCFullYear() - 1}
        departments={dir.departments.map((d) => ({ id: d.id, label: d.name, sub: d.code }))}
        entities={dir.entities.map((e) => ({ id: e.id, label: e.name, sub: `${e.country} · ${e.currency}` }))}
        people={dir.users.filter((u) => u.role === "contributor").map((u) => ({ id: u.id, label: u.name, sub: u.title }))}
      />
    </>
  );
}
