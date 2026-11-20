import { NextResponse, type NextRequest } from "next/server";

/** Gives every request an id (kept if the caller sent a sane one) and echoes it back, so a user-visible error can be traced to logs. */
export function proxy(req: NextRequest) {
  const incoming = req.headers.get("x-request-id");
  const id = incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  const headers = new Headers(req.headers);
  headers.set("x-request-id", id);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("x-request-id", id);
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
