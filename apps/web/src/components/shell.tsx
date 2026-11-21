"use client";
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LayoutDashboard, FileText, History, Building2, Bot, Settings, Bell, Ellipsis, LogOut, type LucideIcon } from "lucide-react";
import { Avatar } from "./ui";

const ICONS: Record<string, LucideIcon> = { dashboard: LayoutDashboard, requests: FileText, review: Bot, audit: History, directory: Building2, settings: Settings, notifications: Bell };
export interface NavItem { href: string; label: string; short: string; icon: keyof typeof ICONS; badge?: number }

const isActive = (pathname: string, href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

/** Shows a pending state the moment a link is pressed, before the route has loaded (useLinkStatus). */
function Pending({ children }: { children: ReactNode }) {
  const { pending } = useLinkStatus();
  return <span data-pending={pending ? "true" : undefined} className="contents">{children}</span>;
}

function Badge({ n }: { n: number }) {
  return <span aria-label={`${n} new`} className="tnum rounded-full px-1.5 text-[11px] font-semibold" style={{ background: "var(--violet-bg)", color: "var(--violet-fg)" }}>{n}</span>;
}

/** Desktop sidebar navigation. */
export function SidebarNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {items.map((item) => {
        const Icon = ICONS[item.icon]!;
        const active = isActive(pathname, item.href);
        return (
          <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} className="navlink">
            <Pending><Icon size={17} aria-hidden /><span className="flex-1">{item.label}</span></Pending>
            {item.badge ? <Badge n={item.badge} /> : null}
          </Link>
        );
      })}
    </nav>
  );
}

/** Phone navigation: translucent bottom tab bar (thumb reach) with the overflow behind a "More" sheet. */
export function TabBar({ items, name, role, signOut }: { items: NavItem[]; name: string; role: string; signOut: () => void | Promise<void> }) {
  const pathname = usePathname();
  const primary = items.slice(0, 4);
  const rest = items.slice(4);
  const [more, setMore] = useState(false);
  const dlg = useRef<HTMLDialogElement>(null);
  useEffect(() => { setMore(false); }, [pathname]);
  useEffect(() => { const d = dlg.current; if (!d) return; if (more && !d.open) d.showModal(); if (!more && d.open) d.close(); }, [more]);
  const restActive = rest.some((i) => isActive(pathname, i.href));
  return (
    <>
      <nav aria-label="Main" className="tabbar material lg:hidden">
        {primary.map((item) => {
          const Icon = ICONS[item.icon]!;
          const active = isActive(pathname, item.href);
          return (
            <Link key={item.href} href={item.href} className="tab" aria-current={active ? "page" : undefined}>
              <Pending><Icon size={22} aria-hidden strokeWidth={active ? 2.2 : 1.8} /><span>{item.short}</span></Pending>
              {item.badge ? <span className="tab-badge" aria-label={`${item.badge} new`}>{item.badge}</span> : null}
            </Link>
          );
        })}
        <button type="button" className="tab" aria-haspopup="dialog" aria-current={restActive ? "page" : undefined} onClick={() => setMore(true)}>
          <Ellipsis size={22} aria-hidden /><span>More</span>
        </button>
      </nav>
      <dialog ref={dlg} className="sheet lg:hidden" aria-label="More" onClose={() => setMore(false)} onClick={(e) => { if (e.target === dlg.current) setMore(false); }}>
        <div className="sheet-panel" style={{ touchAction: "auto" }}>
          <div className="sheet-grabber" aria-hidden />
          <div className="flex items-center gap-3"><Avatar name={name} size={40} /><div className="min-w-0"><p className="truncate font-semibold text-ink">{name}</p><p className="t-small text-muted">{role}</p></div></div>
          <div className="flex flex-col">
            {rest.map((item) => {
              const Icon = ICONS[item.icon]!;
              return <Link key={item.href} href={item.href} className="navlink" style={{ minHeight: 48 }} aria-current={isActive(pathname, item.href) ? "page" : undefined}><Icon size={19} aria-hidden /><span className="flex-1">{item.label}</span></Link>;
            })}
          </div>
          <form action={signOut}><button type="submit" className="btn btn-secondary btn-lg w-full"><LogOut size={16} aria-hidden /> Sign out</button></form>
        </div>
      </dialog>
    </>
  );
}

/**
 * Sticky toolbar: transparent at rest, turns into a material once content scrolls under it, and shows the page title only
 * after the large title has scrolled away.
 */
export function Toolbar({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  const pathname = usePathname();
  const [title, setTitle] = useState("");
  useEffect(() => {
    const root = document.documentElement;
    const onScroll = () => root.setAttribute("data-scrolled", window.scrollY > 4 ? "true" : "false");
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    root.removeAttribute("data-title-collapsed");
    let io: IntersectionObserver | undefined;
    const raf = requestAnimationFrame(() => {
      const h1 = document.querySelector<HTMLElement>("[data-large-title]");
      setTitle(h1?.textContent ?? "");
      if (!h1) return;
      io = new IntersectionObserver(([e]) => { if (e) root.setAttribute("data-title-collapsed", e.isIntersecting ? "false" : "true"); }, { rootMargin: "-56px 0px 0px 0px" });
      io.observe(h1);
    });
    return () => { cancelAnimationFrame(raf); io?.disconnect(); };
  }, [pathname]);
  return (
    <div className="toolbar" role="banner">
      <div className="flex min-w-0 flex-1 items-center gap-3">{left}<span className="toolbar-title" aria-hidden>{title}</span></div>
      {right}
    </div>
  );
}
