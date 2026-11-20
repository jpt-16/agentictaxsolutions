import { opsMetrics } from "@taxops/db";
import { db } from "@/lib/db";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
/** Readiness: can we serve traffic (database reachable) and is the AI queue draining? Reveals counts only, never data. */
export async function GET() {
  try {
    const m = await opsMetrics(db);
    return Response.json({ status: "ready", queue: { oldestRunnableSeconds: m.oldest_queued_seconds, deadJobs: m.dead_jobs } }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    log.error("readiness check failed", { error: e });
    return Response.json({ status: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
