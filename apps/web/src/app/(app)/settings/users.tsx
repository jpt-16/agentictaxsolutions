"use client";
import { useState, useTransition } from "react";
import { UserPlus } from "lucide-react";
import { ROLES, ROLE_LABELS, type Role } from "@taxops/core";
import { createUserAction, updateUserAction } from "./actions";
import { Badge } from "@/components/ui";

interface U { id: string; name: string; email: string; title: string; role: Role; isActive: boolean; departmentId: string | null; entityId: string | null; department: string | null; entity: string | null }
interface Opt { id: string; name: string }

function Row({ u, depts, ents, self }: { u: U; depts: Opt[]; ents: Opt[]; self: boolean }) {
  const [role, setRole] = useState<Role>(u.role);
  const [dept, setDept] = useState(u.departmentId ?? ""), [ent, setEnt] = useState(u.entityId ?? "");
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const dirty = role !== u.role || dept !== (u.departmentId ?? "") || ent !== (u.entityId ?? "");
  const run = (patch: Record<string, unknown>, ok: string) => { setMsg(null); start(async () => { const r = await updateUserAction(u.id, patch); setMsg(r.ok ? ok : r.error); }); };
  return (
    <tr className={u.isActive ? "" : "opacity-60"}>
      <td><p className="font-medium text-ink">{u.name}{self && <span className="ml-1.5 text-[11px] font-normal text-muted">(you)</span>}</p><p className="text-[12px] text-muted">{u.email}</p></td>
      <td><select aria-label={`Role for ${u.name}`} className="field !w-40" value={role} disabled={self} onChange={(e) => setRole(e.target.value as Role)}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select></td>
      <td><select aria-label={`Department for ${u.name}`} className="field !w-44" value={dept} onChange={(e) => setDept(e.target.value)}><option value="">—</option>{depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></td>
      <td><select aria-label={`Entity for ${u.name}`} className="field !w-44" value={ent} onChange={(e) => setEnt(e.target.value)}><option value="">—</option>{ents.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></td>
      <td className="whitespace-nowrap">
        <div className="flex items-center gap-2">
          <button className="btn btn-secondary btn-sm" disabled={!dirty || pending} onClick={() => run({ role, departmentId: dept || null, entityId: ent || null }, "Saved")}>Save</button>
          {!self && <button className="btn btn-ghost btn-sm" disabled={pending} onClick={() => { if (u.isActive && !window.confirm(`Deactivate ${u.name}? They will be signed out and lose access immediately.`)) return; run({ isActive: !u.isActive }, u.isActive ? "Deactivated" : "Reactivated"); }}>{u.isActive ? "Deactivate" : "Reactivate"}</button>}
        </div>
        {msg && <p role="status" className="mt-1 text-[12px] text-muted">{msg}</p>}
      </td>
    </tr>
  );
}

export function UsersTable({ users, depts, ents, selfId }: { users: U[]; depts: Opt[]; ents: Opt[]; selfId: string }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", email: "", title: "", role: "contributor" as Role, departmentId: "", entityId: "" });
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="tbl !text-[13px]">
          <thead><tr><th>Person</th><th>Role</th><th>Department</th><th>Entity</th><th /></tr></thead>
          <tbody>{users.map((u) => <Row key={u.id} u={u} depts={depts} ents={ents} self={u.id === selfId} />)}</tbody>
        </table>
      </div>
      <div className="border-t border-line px-5 py-4">
        {!open ? <button className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}><UserPlus size={13} aria-hidden /> Add a person</button> : (
          <form className="grid gap-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); setErr(null); start(async () => { const r = await createUserAction({ ...f, departmentId: f.departmentId || null, entityId: f.entityId || null }); if (!r.ok) setErr(r.error); else { setOpen(false); setF({ name: "", email: "", title: "", role: "contributor", departmentId: "", entityId: "" }); } }); }}>
            <div><label className="label" htmlFor="nu-name">Name</label><input id="nu-name" className="field" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
            <div><label className="label" htmlFor="nu-email">Work email</label><input id="nu-email" type="email" className="field" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
            <div><label className="label" htmlFor="nu-title">Job title</label><input id="nu-title" className="field" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
            <div><label className="label" htmlFor="nu-role">Role</label><select id="nu-role" className="field" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select></div>
            <div><label className="label" htmlFor="nu-dept">Department</label><select id="nu-dept" className="field" value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}><option value="">—</option>{depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
            <div><label className="label" htmlFor="nu-ent">Entity</label><select id="nu-ent" className="field" value={f.entityId} onChange={(e) => setF({ ...f, entityId: e.target.value })}><option value="">—</option>{ents.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
            <div className="flex items-center gap-2 sm:col-span-3"><button type="submit" className="btn btn-primary btn-sm" disabled={pending}>{pending ? "Adding…" : "Add person"}</button><button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Cancel</button>{err && <span role="alert" className="text-[12.5px]" style={{ color: "var(--red-fg)" }}>{err}</span>}</div>
          </form>
        )}
        <p className="hint mt-3">People sign in through your identity provider with this email. <Badge tone="slate">No passwords are stored here</Badge></p>
      </div>
    </div>
  );
}
