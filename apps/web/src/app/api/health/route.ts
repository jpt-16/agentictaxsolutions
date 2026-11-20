export const dynamic = "force-dynamic";
/** Liveness: the process is up. Deliberately does not touch the database. */
export function GET() { return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } }); }
