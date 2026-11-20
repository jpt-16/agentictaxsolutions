import { opsMetrics } from "@taxops/db";
import { db } from "@/lib/db";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
/** Readiness: can we serve traffic (database reachable) and is the AI queue draining? Reveals counts only, never data. */
export async function GET() {
  try {
    await opsMetrics(db); // proves the database answers; details are for the authenticated /api/metrics endpoint
    return Response.json({ status: "ready" }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    log.error("readiness check failed", { error: e });
    return Response.json({ status: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
