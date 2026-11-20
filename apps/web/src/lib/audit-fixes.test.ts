import { describe, expect, it } from "vitest";
import { formatLog, scrub } from "./log";
import { BodyTooLargeError, LengthRequiredError, readFormDataCapped } from "./body-limit";
import { safeLocalPath } from "./safe-redirect";
import { checkAuthSecret } from "./auth-secret";

describe("#2 logs never carry query parameter values", () => {
  it("drops the params section of database errors, at any nesting level", () => {
    const e = new Error("Failed query: insert into submissions (note) values ($1)\nparams: Payroll for jane@corp.example SSN 123-45-6789", { cause: new Error("x\nparams: secret-value") });
    const line = formatLog("error", "unhandled action error", { error: e, nested: { msg: "params: 4111 1111 1111 1111" } });
    expect(line).not.toMatch(/123-45-6789|jane@corp|secret-value|4111/);
    expect(line).toContain("insert into submissions"); // the query shape is kept for debugging
    expect(scrub("no parameters here")).toBe("no parameters here");
  });
});

describe("#5 request bodies are capped while streaming", () => {
  const multipart = (size: number, declared?: string | null) => {
    const boundary = "XyZ";
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\n${"a".repeat(size)}\r\n--${boundary}--\r\n`;
    const headers: Record<string, string> = { "content-type": `multipart/form-data; boundary=${boundary}` };
    if (declared !== null) headers["content-length"] = declared ?? String(Buffer.byteLength(body));
    return new Request("http://x/", { method: "POST", headers, body, duplex: "half" } as RequestInit);
  };
  it("accepts a body within the limit", async () => {
    expect((await readFormDataCapped(multipart(100), 10_000)).get("note")).toHaveLength(100);
  });
  it("refuses a missing length (chunked), an oversized declared length, and a body that lies about its length", async () => {
    await expect(readFormDataCapped(multipart(100, null), 10_000)).rejects.toBeInstanceOf(LengthRequiredError);
    await expect(readFormDataCapped(multipart(100, "999999"), 10_000)).rejects.toBeInstanceOf(BodyTooLargeError);
    await expect(readFormDataCapped(multipart(100, "abc"), 10_000)).rejects.toBeInstanceOf(BodyTooLargeError);
    const liar = new Request("http://x/", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=XyZ", "content-length": "50" },
      body: new ReadableStream({ start(c) { for (let i = 0; i < 100; i++) c.enqueue(new Uint8Array(1024)); c.close(); } }), duplex: "half" } as RequestInit);
    await expect(readFormDataCapped(liar, 10_000)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});

describe("#11 redirects stay on this site", () => {
  it("allows local paths and refuses every off-site form", () => {
    expect(safeLocalPath("/requests/abc?x=1#item-2")).toBe("/requests/abc?x=1#item-2");
    for (const bad of ["//evil.com", "/\\evil.com", "/\\/evil.com", "https://evil.com", "javascript:alert(1)", "evil.com", "/ok\nSet-Cookie: x", "", null, "/" + "a".repeat(600)])
      expect(safeLocalPath(bad as string, "/fallback")).toBe("/fallback");
  });
});

describe("#4 the session secret", () => {
  it("rejects missing/short secrets everywhere and placeholder or predictable ones in production", () => {
    expect(checkAuthSecret(undefined, false)).toMatch(/at least 32/);
    expect(checkAuthSecret("short", true)).toMatch(/at least 32/);
    expect(checkAuthSecret("change-me-to-a-long-random-string-at-least-32-chars", true)).toMatch(/placeholder/);
    expect(checkAuthSecret("ci-only-secret-ci-only-secret-ci-only-secret", true)).toMatch(/placeholder/);
    expect(checkAuthSecret("a".repeat(64), true)).toMatch(/placeholder|predictable/);
    expect(checkAuthSecret("abababababababababababababababababababab", true)).toMatch(/predictable/);
    expect(checkAuthSecret("change-me-to-a-long-random-string-at-least-32-chars", false)).toBeNull();
    expect(checkAuthSecret("q3Zr8vK1pXw9LmT2bN6yHc4JdF7sGa0eUoRi5VtQ", true)).toBeNull();
  });
});
