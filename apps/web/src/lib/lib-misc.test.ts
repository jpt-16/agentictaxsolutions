import { describe, expect, it } from "vitest";
import { isRevoked } from "./session-revocation";
import { formatLog, requestIdFrom, sanitize } from "./log";
import { renderMetrics } from "./metrics";
import { RateLimiter, clientKey } from "./rate-limit";

describe("structured logging", () => {
  it("emits one parseable JSON line and redacts sensitive keys at any depth", () => {
    const line = formatLog("info", "login", { userId: "u1", session: "abc", nested: { authorization: "Bearer x", ok: 1 }, note: "secret text", code_verifier: "v" }, new Date("2026-01-01T00:00:00Z"));
    const o = JSON.parse(line);
    expect(o).toMatchObject({ ts: "2026-01-01T00:00:00.000Z", level: "info", msg: "login", userId: "u1", session: "[redacted]", note: "[redacted]", code_verifier: "[redacted]" });
    expect(o.nested).toEqual({ authorization: "[redacted]", ok: 1 });
    expect(line).not.toMatch(/Bearer|secret text/);
  });
  it("clips huge strings, bounds depth and arrays, and flattens errors", () => {
    expect((sanitize("x".repeat(2000)) as string).length).toBeLessThan(600);
    expect((sanitize(Array.from({ length: 100 }, (_, i) => i)) as number[]).length).toBe(20);
    expect(sanitize({ a: { b: { c: { d: { e: 1 } } } } })).toEqual({ a: { b: { c: { d: "[nested]" } } } });
    expect(sanitize(new Error("boom", { cause: new Error("inner") }))).toEqual({ name: "Error", message: "boom", cause: "inner" });
  });
  it("accepts a sane incoming request id and replaces junk", () => {
    const h = (v: string | null) => ({ get: () => v });
    expect(requestIdFrom(h("abc-12345678"))).toBe("abc-12345678");
    for (const bad of [null, "short", "has spaces and \n newline", "x".repeat(200), "<script>alert(1)</script>"]) expect(requestIdFrom(h(bad))).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("metrics exposition", () => {
  it("renders Prometheus text with escaped labels and aggregate values only", () => {
    const text = renderMetrics({ jobs: { "file.uploaded:queued": 3, 'weird"type:dead': 1 }, oldest_queued_seconds: 12, dead_jobs: 1, proposals_pending: 4, tenants: 2, audit_events: 99 });
    expect(text).toContain('taxops_jobs{type="file.uploaded",status="queued"} 3');
    expect(text).toContain('type="weird\\"type"');
    expect(text).toContain("taxops_queue_oldest_runnable_seconds 12");
    expect(text).toContain("# TYPE taxops_proposals_pending gauge");
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("rate limiter", () => {
  it("allows up to the limit per window, then refuses with a retry hint, and recovers", () => {
    let t = 0; const rl = new RateLimiter(3, 1000, () => t);
    expect([rl.hit("a").ok, rl.hit("a").ok, rl.hit("a").ok]).toEqual([true, true, true]);
    const blocked = rl.hit("a");
    expect(blocked).toMatchObject({ ok: false, remaining: 0 }); expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(rl.hit("b").ok).toBe(true);        // keys are independent
    t = 1001; expect(rl.hit("a").ok).toBe(true); // the window slid past
  });
  it("bounds memory when flooded with distinct keys", () => {
    const rl = new RateLimiter(1, 60_000, () => 0, 100);
    for (let i = 0; i < 1000; i++) rl.hit(`k${i}`);
    expect((rl as unknown as { hits: Map<string, number[]> }).hits.size).toBeLessThanOrEqual(101);
  });
  it("only believes forwarding headers through the configured number of trusted proxies", () => {
    const h = (m: Record<string, string>) => ({ get: (n: string) => m[n] ?? null });
    expect(clientKey(h({ "x-forwarded-for": "6.6.6.6" }), 0)).toBe("direct");                              // no proxy: header is ignored entirely
    expect(clientKey(h({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }), 1)).toBe("203.0.113.9");           // forged left entry is ignored
    expect(clientKey(h({ "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.0.0.1" }), 2)).toBe("203.0.113.9");
    expect(clientKey(h({}), 1)).toBe("unknown");
    expect(clientKey(h({ "x-forwarded-for": "x".repeat(300) }), 1)).toBe("unknown");
  });
});

describe("session revocation", () => {
  it("voids tokens issued before a sign-out, including tokens with no issue time", () => {
    expect(isRevoked(1000, null)).toBe(false);          // never signed out
    expect(isRevoked(2000, 1500)).toBe(false);          // issued after the sign-out
    expect(isRevoked(1000, 1500)).toBe(true);           // issued before it
    expect(isRevoked(undefined, 1500)).toBe(true);      // legacy token
    expect(isRevoked("2000", 1500)).toBe(true);         // wrong type is never trusted
  });
});
