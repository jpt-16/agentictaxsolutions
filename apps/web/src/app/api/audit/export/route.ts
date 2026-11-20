import { exportAudit, toCsv } from "@taxops/services";
import { getContext } from "@/lib/auth";
import { errorResponse, isSameOrigin } from "@/lib/http";
import { clientKey, limiter, tooMany } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
const CATEGORIES = new Set(["request.", "item.", "comment.", "file.", "proposal.", "user.", "auth."]);

/** POST (not GET) so a link or image tag on another site cannot trigger an export; same-origin enforced. */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return Response.json({ ok: false, error: "Cross-origin request refused." }, { status: 403 });
  const ctx = await getContext();
  if (!ctx) return Response.json({ ok: false, error: "Please sign in again." }, { status: 401 });
  const rl = limiter("audit-export", 6, 60_000).hit(ctx.session.userId);
  if (!rl.ok) return tooMany(rl.retryAfterSec);
  try {
    const form = await req.formData();
    const format = form.get("format") === "csv" ? "csv" : "json";
    const cat = String(form.get("cat") ?? "");
    const exp = await exportAudit(ctx, { actionPrefix: CATEGORIES.has(cat) ? cat : undefined });
    const stamp = exp.meta.exportedAt.slice(0, 19).replace(/[:T]/g, "-");
    const body = format === "csv" ? toCsv(exp) : JSON.stringify(exp, null, 2);
    return new Response(body, { headers: {
      "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/json",
      "Content-Disposition": `attachment; filename="audit-${stamp}.${format}"`,
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch (e) { return errorResponse(e); }
}
