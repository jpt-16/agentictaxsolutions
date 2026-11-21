import { LogOut, ShieldCheck } from "lucide-react";
import { can, ROLE_LABELS } from "@taxops/core";
import { pendingProposalCount, unreadCount } from "@taxops/services";
import { requireContext, devAuthEnabled } from "@/lib/auth";
import { signOut } from "../login/actions";
import { SidebarNav, TabBar, Toolbar, type NavItem } from "@/components/shell";
import { OverlayProvider } from "@/components/overlays";
import { Avatar } from "@/components/ui";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireContext();
  const { role, name } = ctx.session;
  const pending = await pendingProposalCount(ctx);
  const unread = await unreadCount(ctx);
  const nav: NavItem[] = [
    { href: "/", label: "Dashboard", short: "Home", icon: "dashboard" },
    { href: "/requests", label: "Information requests", short: "Requests", icon: "requests" },
    ...(can(role, "proposal.read") ? [{ href: "/review", label: "AI review", short: "Review", icon: "review", badge: pending } as NavItem] : []),
    { href: "/notifications", label: "Notifications", short: "Alerts", icon: "notifications", badge: unread },
    ...(can(role, "report.read") ? [{ href: "/reports", label: "Reports", short: "Reports", icon: "reports" } as NavItem] : []),
    ...(can(role, "audit.read") ? [{ href: "/audit", label: "Audit history", short: "Audit", icon: "audit" } as NavItem] : []),
    ...(can(role, "user.read") ? [{ href: "/directory", label: "Directory", short: "Directory", icon: "directory" } as NavItem] : []),
    ...(can(role, "rules.manage") || can(role, "tenant.admin") ? [{ href: "/settings", label: "Settings", short: "Settings", icon: "settings" } as NavItem] : []),
  ];

  return (
    <OverlayProvider>
      <div className="min-h-screen lg:grid lg:grid-cols-[256px_1fr]">
        <aside className="sidebar material-thick hidden lg:sticky lg:top-0 lg:block lg:h-screen">
          <div className="flex h-full flex-col px-3 py-5">
            <div className="mb-6 flex items-center gap-2.5 px-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-[9px]" style={{ background: "var(--accent-solid)", color: "#fff" }}>
                <ShieldCheck size={17} aria-hidden />
              </span>
              <span className="t-head text-ink">Tax Operations</span>
            </div>
            <SidebarNav items={nav} />
            <div className="flex-1" />
            <div className="mt-4 border-t border-line pt-3">
              <div className="flex items-center gap-2.5 px-2">
                <Avatar name={name} size={34} />
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
        <div className="min-w-0 pb-[calc(76px+env(safe-area-inset-bottom,0px))] lg:pb-0">
          {devAuthEnabled() && (
            <div className="px-6 py-1.5 text-center text-[12px] font-medium" style={{ background: "var(--amber-bg)", color: "var(--amber-fg)" }}>
              Development environment · fictional data only
            </div>
          )}
          <Toolbar />
          <main id="main" className="mx-auto max-w-[1180px] px-4 pb-10 pt-2 sm:px-8">{children}</main>
        </div>
        <TabBar items={nav} name={name} role={ROLE_LABELS[role]} signOut={signOut} />
      </div>
    </OverlayProvider>
  );
}
