import { exportStatusReportCsv } from "@taxops/services";
import { getContext } from "@/lib/auth";
import { errorResponse, isSameOrigin } from "@/lib/http";
import { limiter, tooMany } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** POST (not GET) so another site cannot trigger an export by linking here; same-origin enforced. Every export is audited. */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return Response.json({ ok: false, error: "Cross-origin request refused." }, { status: 403 });
  const ctx = await getContext();
  if (!ctx) return Response.json({ ok: false, error: "Please sign in again." }, { status: 401 });
  const rl = limiter("report-export", 10, 60_000).hit(ctx.session.userId);
  if (!rl.ok) return tooMany(rl.retryAfterSec);
  try {
    const csv = await exportStatusReportCsv(ctx);
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(csv, { headers: {
      "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="request-status-${stamp}.csv"`,
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch (e) { return errorResponse(e); }
}
