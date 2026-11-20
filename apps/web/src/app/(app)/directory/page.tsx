import { notFound } from "next/navigation";
import { can, ROLE_LABELS } from "@taxops/core";
import { listDirectory } from "@taxops/services";
import { requireContext } from "@/lib/auth";
import { Avatar, Badge, Card, CardHeader, PageHeader } from "@/components/ui";

export const metadata = { title: "Directory" };
export const dynamic = "force-dynamic";

export default async function DirectoryPage() {
  const ctx = await requireContext();
  if (!can(ctx.session.role, "user.read")) notFound();
  const dir = await listDirectory(ctx);
  const dept = new Map(dir.departments.map((d) => [d.id, d.name]));
  const ent = new Map(dir.entities.map((e) => [e.id, e.name]));

  return (
    <>
      <PageHeader title="Directory" subtitle="The subsidiaries, departments and people requests can be assigned to." />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Legal entities" subtitle={`${dir.entities.length} subsidiaries`} />
          <table className="tbl">
            <thead><tr><th>Entity</th><th>Code</th><th>Country</th><th>Currency</th></tr></thead>
            <tbody>{dir.entities.map((e) => (
              <tr key={e.id}><td className="font-medium text-ink">{e.name}</td><td className="tnum text-muted">{e.code}</td><td>{e.country}</td><td>{e.currency}</td></tr>
            ))}</tbody>
          </table>
        </Card>
        <Card>
          <CardHeader title="Departments" subtitle={`${dir.departments.length} departments`} />
          <table className="tbl">
            <thead><tr><th>Department</th><th>Code</th></tr></thead>
            <tbody>{dir.departments.map((d) => (
              <tr key={d.id}><td className="font-medium text-ink">{d.name}</td><td className="tnum text-muted">{d.code}</td></tr>
            ))}</tbody>
          </table>
        </Card>
      </div>
      <Card className="mt-5">
        <CardHeader title="People" subtitle={`${dir.users.length} active users`} />
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Name</th><th>Role</th><th>Department</th><th>Entity</th></tr></thead>
            <tbody>{dir.users.map((u) => (
              <tr key={u.id}>
                <td><div className="flex items-center gap-3"><Avatar name={u.name} /><div><p className="font-medium text-ink">{u.name}</p><p className="text-[12px] text-muted">{u.title}</p></div></div></td>
                <td><Badge tone={u.role === "contributor" ? "slate" : "blue"}>{ROLE_LABELS[u.role]}</Badge></td>
                <td>{u.departmentId ? dept.get(u.departmentId) : <span className="text-subtle">—</span>}</td>
                <td>{u.entityId ? ent.get(u.entityId) : <span className="text-subtle">—</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
