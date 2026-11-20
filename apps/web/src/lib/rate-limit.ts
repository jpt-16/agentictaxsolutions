/**
 * Sliding-window rate limiter. In-memory, so it limits per server instance; behind several instances put the same policy at the
 * edge (WAF/gateway) or swap this for a shared store. It exists so no single endpoint is trivially abusable in the meantime.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number = Date.now, private readonly maxKeys = 10_000) {}

  hit(key: string): { ok: boolean; remaining: number; retryAfterSec: number } {
    const t = this.now();
    const fresh = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (fresh.length >= this.limit) {
      this.hits.set(key, fresh);
      return { ok: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((fresh[0]! + this.windowMs - t) / 1000)) };
    }
    fresh.push(t);
    this.hits.delete(key); this.hits.set(key, fresh); // keep recently used keys last
    if (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value as string); // bound memory under key-flooding
    return { ok: true, remaining: this.limit - fresh.length, retryAfterSec: 0 };
  }
}

/** Best-effort client address. X-Forwarded-For is only trustworthy behind a proxy you control that overwrites it. */
export function clientKey(headers: { get(n: string): string | null }): string {
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff && xff.length <= 64 ? xff : headers.get("x-real-ip") ?? "unknown";
}

const g = globalThis as unknown as { __limiters?: Map<string, RateLimiter> };
export function limiter(name: string, limit: number, windowMs: number): RateLimiter {
  const all = (g.__limiters ??= new Map());
  let l = all.get(name);
  if (!l) all.set(name, (l = new RateLimiter(limit, windowMs)));
  return l;
}

export function tooMany(retryAfterSec: number): Response {
  return Response.json({ ok: false, error: "Too many requests. Please slow down." }, { status: 429, headers: { "Retry-After": String(retryAfterSec) } });
}
