/**
 * Only ever follow a path on THIS site. Rejects "//evil.com", "/\\evil.com" (browsers treat a backslash like a slash),
 * schemes, control characters and anything that resolves to another origin.
 */
export function safeLocalPath(link: string | null | undefined, fallback = "/"): string {
  if (!link || typeof link !== "string" || link.length > 500) return fallback;
  if (!link.startsWith("/") || link.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(link)) return fallback;
  try {
    const u = new URL(link, "https://app.invalid");
    if (u.origin !== "https://app.invalid") return fallback;
    return u.pathname + u.search + u.hash;
  } catch { return fallback; }
}
