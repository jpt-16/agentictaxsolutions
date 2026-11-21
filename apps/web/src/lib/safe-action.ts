import type { ActionResult } from "./actions";

/**
 * Calls a server action from the browser and never lets a NETWORK failure escape. Without this, a dropped connection mid-action makes
 * React replace the whole page with the generic error screen, and whatever the person had typed is lost. Here it becomes an ordinary
 * inline error and the form keeps its contents. Redirects and not-found signals still pass through untouched.
 */
export async function safely<T>(call: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await call();
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e && String((e as { digest: unknown }).digest).startsWith("NEXT_")) throw e;
    return { ok: false, error: "Could not reach the server. Check your connection and try again. What you typed is still here." };
  }
}
