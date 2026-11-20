import { Bell, CheckCheck } from "lucide-react";
import { listNotifications } from "@taxops/services";
import { requireContext } from "@/lib/auth";
import { Card, EmptyState, PageHeader, formatDateTime } from "@/components/ui";
import { markAllReadAction, openNotification } from "./actions";

export const metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const ctx = await requireContext();
  const items = await listNotifications(ctx, { limit: 100 });
  const unread = items.filter((n) => !n.readAt).length;
  return (
    <>
      <PageHeader title="Notifications" subtitle={unread ? `${unread} unread` : "You’re all caught up"}
        actions={unread ? <form action={markAllReadAction}><button className="btn btn-secondary" type="submit"><CheckCheck size={15} aria-hidden /> Mark all as read</button></form> : undefined} />
      <Card>
        {items.length === 0 ? <EmptyState icon={<Bell size={18} />} title="No notifications yet" body="You’ll be told here when work is assigned to you, submitted for review, or due." /> : (
          <ul className="divide-y divide-line">
            {items.map((n) => (
              <li key={n.id}>
                <form action={openNotification}>
                  <input type="hidden" name="id" value={n.id} /><input type="hidden" name="link" value={n.link ?? "/notifications"} />
                  <button type="submit" className="flex w-full items-start gap-3 px-5 py-3.5 text-left transition-colors hover:bg-surface2">
                    <span aria-hidden className="mt-1.5 h-2 w-2 flex-none rounded-full" style={{ background: n.readAt ? "transparent" : "var(--accent)" }} />
                    <span className="min-w-0 flex-1">
                      <span className={`block ${n.readAt ? "text-body" : "font-medium text-ink"}`}>{n.title}{!n.readAt && <span className="sr-only"> (unread)</span>}</span>
                      {n.body && <span className="mt-0.5 block truncate text-[13px] text-muted">{n.body}</span>}
                    </span>
                    <span className="flex-none text-[12px] text-muted">{formatDateTime(n.createdAt)}</span>
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
