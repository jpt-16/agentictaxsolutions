import { approvedDataPack, csvOf, DATA_PACK_COLUMNS } from "@taxops/services";
import { getContext } from "@/lib/auth";
import { errorResponse, isSameOrigin } from "@/lib/http";
import { limiter, tooMany } from "@/lib/rate-limit";
import { readFormDataCapped } from "@/lib/body-limit";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The accepted data for one request as CSV. POST + same-origin; every export is audited. */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return Response.json({ ok: false, error: "Cross-origin request refused." }, { status: 403 });
  const ctx = await getContext();
  if (!ctx) return Response.json({ ok: false, error: "Please sign in again." }, { status: 401 });
  const rl = limiter("report-export", 10, 60_000).hit(ctx.session.userId);
  if (!rl.ok) return tooMany(rl.retryAfterSec);
  try {
    const form = await readFormDataCapped(req, 16 * 1024).catch(() => new FormData());
    const requestId = String(form.get("requestId") ?? "");
    if (!UUID.test(requestId)) return Response.json({ ok: false, error: "Choose a request." }, { status: 400 });
    const pack = await approvedDataPack(ctx, requestId);
    return new Response(csvOf(DATA_PACK_COLUMNS, pack.rows), { headers: {
      "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${pack.reference}-approved-data.csv"`,
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch (e) { return errorResponse(e); }
}
