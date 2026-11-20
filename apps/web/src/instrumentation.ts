/**
 * Runs once when the server starts. A production server with an unsafe authentication setup refuses to start at all,
 * instead of failing later at sign-in (or worse, running with a known secret).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "production") {
    const { assertSafeProductionConfig } = await import("./instrumentation-node");
    assertSafeProductionConfig();
  }
}
