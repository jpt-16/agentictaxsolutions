import { LogOut, ShieldCheck } from "lucide-react";
import { can, ROLE_LABELS } from "@taxops/core";
import { pendingProposalCount } from "@taxops/services";
import { requireContext, devAuthEnabled } from "@/lib/auth";
import { signOut } from "../login/actions";
import { SidebarNav, type NavItem } from "@/components/sidebar";
import { Avatar } from "@/components/ui";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireContext();
  const { role, name } = ctx.session;
  const pending = await pendingProposalCount(ctx);
  const nav: NavItem[] = [
    { href: "/", label: "Dashboard", icon: "dashboard" },
    { href: "/requests", label: "Information requests", icon: "requests" },
    ...(can(role, "proposal.read") ? [{ href: "/review", label: "AI review", icon: "review", badge: pending } as NavItem] : []),
    ...(can(role, "audit.read") ? [{ href: "/audit", label: "Audit history", icon: "audit" } as NavItem] : []),
    ...(can(role, "user.read") ? [{ href: "/directory", label: "Directory", icon: "directory" } as NavItem] : []),
  ];

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[252px_1fr]">
      <aside className="border-b border-line bg-surface lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r">
        <div className="flex h-full flex-col px-3 py-4">
          <div className="mb-5 flex items-center gap-2.5 px-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: "var(--primary)", color: "var(--primary-fg)" }}>
              <ShieldCheck size={17} aria-hidden />
            </span>
            <span className="font-semibold tracking-tight text-ink">Tax Operations</span>
          </div>
          <SidebarNav items={nav} />
          <div className="mt-4 hidden flex-1 lg:block" />
          <div className="mt-4 border-t border-line pt-3">
            <div className="flex items-center gap-2.5 px-2">
              <Avatar name={name} size={32} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-ink">{name}</p>
                <p className="truncate text-[12px] text-muted">{ROLE_LABELS[role]}</p>
              </div>
              <form action={signOut}>
                <button type="submit" className="btn btn-ghost btn-sm" aria-label="Sign out" title={devAuthEnabled() ? "Switch user / sign out" : "Sign out"}>
                  <LogOut size={15} aria-hidden />
                </button>
              </form>
            </div>
          </div>
        </div>
      </aside>
      <div className="min-w-0">
        {devAuthEnabled() && (
          <div className="px-6 py-1.5 text-center text-[12px] font-medium" style={{ background: "var(--amber-bg)", color: "var(--amber-fg)" }}>
            Development environment · fictional data only
          </div>
        )}
        <main id="main" className="mx-auto max-w-[1180px] px-5 py-7 sm:px-8">{children}</main>
      </div>
    </div>
  );
}
