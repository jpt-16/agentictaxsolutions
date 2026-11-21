import { NextResponse, type NextRequest } from "next/server";

/** Gives every request an id (kept if the caller sent a sane one) and echoes it back, so a user-visible error can be traced to logs. */
export function proxy(req: NextRequest) {
  const incoming = req.headers.get("x-request-id");
  const id = incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  const headers = new Headers(req.headers);
  headers.set("x-request-id", id);

  // Audit #9: a real script policy. Only scripts carrying this per-request nonce (and what they load) may run, so injected
  // markup cannot execute even if escaping were ever bypassed. Next.js reads the nonce from the request header and applies it.
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const dev = process.env.NODE_ENV !== "production";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`, // dev tooling needs eval; production does not
    "style-src 'self' 'unsafe-inline'", // React style attributes
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
  ].join("; ");
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);

  const res = NextResponse.next({ request: { headers } });
  res.headers.set("x-request-id", id);
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

// Excluded here: file downloads (they set their own stricter `sandbox` policy) and the upload endpoint. Next buffers any request that
// passes through this layer and silently truncates the body at 10 MB, which made every file over ~10 MB unreadable. The upload route
// streams its body through its own hard-capped reader instead (see lib/body-limit.ts), and an API response needs no script nonce.
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|api/files/|api/submissions).*)"] };
