import { timingSafeEqual } from "node:crypto";
import { opsMetrics } from "@taxops/db";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { renderMetrics } from "@/lib/metrics";

export const dynamic = "force-dynamic";

/** Prometheus scrape endpoint. Disabled (404) unless METRICS_TOKEN is set; requires it as a bearer token. */
export async function GET(req: Request) {
  const token = process.env.METRICS_TOKEN;
  if (!token) return new Response("Not found", { status: 404 });
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer /i, "");
  const a = Buffer.from(given), b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  try {
    return new Response(renderMetrics(await opsMetrics(db)), { headers: { "Content-Type": "text/plain; version=0.0.4", "Cache-Control": "no-store" } });
  } catch (e) {
    log.error("metrics failed", { error: e });
    return new Response("Unavailable", { status: 503 });
  }
}
