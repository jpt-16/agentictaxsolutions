import { redirect } from "next/navigation";
import { ShieldCheck, FlaskConical } from "lucide-react";
import { ROLE_LABELS, ROLES, type Role } from "@taxops/core";
import { listDevLoginUsers } from "@taxops/services";
import { db } from "@/lib/db";
import { devAuthEnabled, getContext } from "@/lib/auth";
import { Avatar } from "@/components/ui";
import { signInAs } from "./actions";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

const ROLE_BLURB: Record<Role, string> = {
  tax_manager: "Creates requests, assigns work, reviews and closes.",
  tax_reviewer: "Reviews submissions and approves or requests changes.",
  contributor: "Department or subsidiary staff who provide data.",
  auditor: "Read-only access including the full audit history.",
  tenant_admin: "Administers the tenant; read-only on tax content.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getContext()) redirect("/");
  const { error } = await searchParams;
  const enabled = devAuthEnabled();
  const users = enabled ? await listDevLoginUsers(db, process.env.DEV_TENANT_SLUG ?? "northwind") : [];

  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-5 py-12">
      <div className="mb-8 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl text-white" style={{ background: "var(--primary)", color: "var(--primary-fg)" }}>
          <ShieldCheck size={20} aria-hidden />
        </span>
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Tax Operations</h1>
          <p className="text-[13px] text-muted">Data collection &amp; validation</p>
        </div>
      </div>

      {!enabled ? (
        <div className="rounded-xl border border-line bg-surface p-6">
          <p className="font-medium text-ink">Single sign-on required</p>
          <p className="mt-1 text-muted">Sign in through your organization’s identity provider. SSO is not configured for this environment yet.</p>
        </div>
      ) : (
        <>
          <div className="mb-5 flex items-start gap-3 rounded-xl border px-4 py-3" style={{ background: "var(--amber-bg)", borderColor: "transparent", color: "var(--amber-fg)" }}>
            <FlaskConical size={18} className="mt-0.5 flex-none" aria-hidden />
            <p className="text-[13px]"><strong>Development environment.</strong> All people, entities and figures are fictional. Pick a persona to explore what each role can see and do. No password is required in development mode.</p>
          </div>
          {error && <p role="alert" className="mb-4 text-[13px]" style={{ color: "var(--red-fg)" }}>That account could not be signed in.</p>}
          <div className="space-y-6">
            {ROLES.filter((r) => users.some((u) => u.role === r)).sort((a, b) => ["tax_manager","tax_reviewer","contributor","auditor","tenant_admin"].indexOf(a) - ["tax_manager","tax_reviewer","contributor","auditor","tenant_admin"].indexOf(b)).map((role) => (
              <section key={role} aria-labelledby={`role-${role}`}>
                <h2 id={`role-${role}`} className="text-[13px] font-semibold text-ink">{ROLE_LABELS[role]}</h2>
                <p className="mb-2 text-[12.5px] text-muted">{ROLE_BLURB[role]}</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {users.filter((u) => u.role === role).map((u) => (
                    <form key={u.userId} action={signInAs}>
                      <input type="hidden" name="email" value={u.email} />
                      <button type="submit" className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface px-3.5 py-3 text-left transition hover:border-linestrong hover:bg-surface2" style={{ boxShadow: "var(--shadow)" }}>
                        <Avatar name={u.name} size={34} />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-ink">{u.name}</span>
                          <span className="block truncate text-[12.5px] text-muted">{u.title}</span>
                        </span>
                      </button>
                    </form>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
