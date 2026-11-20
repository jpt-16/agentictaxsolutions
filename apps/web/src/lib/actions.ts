import "server-only";
import { ZodError } from "zod";
import { ForbiddenError, InvalidTransitionError } from "@taxops/core";
import { ConflictError, NotFoundError } from "@taxops/services";
import { log } from "./log";

export type ActionResult<T = unknown> =
  | { ok: true; data?: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

/** Converts domain errors into safe, user-facing results. Unknown errors are logged, never leaked. */
export async function guard<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof ZodError) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of e.issues) fieldErrors[issue.path.join(".") || "_"] ??= issue.message;
      return { ok: false, error: Object.values(fieldErrors)[0] ?? "Please check the form.", fieldErrors };
    }
    if (e instanceof ForbiddenError || e instanceof InvalidTransitionError || e instanceof NotFoundError || e instanceof ConflictError) {
      return { ok: false, error: e.message };
    }
    if (e && typeof e === "object" && "digest" in e && String((e as any).digest).startsWith("NEXT_")) throw e; // redirect/notFound
    log.error("unhandled action error", { error: e });
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}
