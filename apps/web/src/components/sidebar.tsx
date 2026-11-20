"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, FileText, History, Building2, type LucideIcon } from "lucide-react";
import { cn } from "./ui";

const ICONS: Record<string, LucideIcon> = { dashboard: LayoutDashboard, requests: FileText, audit: History, directory: Building2 };
export interface NavItem { href: string; label: string; icon: keyof typeof ICONS }

export function SidebarNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {items.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        const Icon = ICONS[item.icon]!;
        return (
          <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined}
            className={cn("flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] font-medium transition-colors",
              active ? "bg-accentsoft text-accent" : "text-muted hover:bg-surface2 hover:text-ink")}>
            <Icon size={17} aria-hidden />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
