import "server-only";
import { ZodError } from "zod";
import { ForbiddenError, InvalidTransitionError } from "@taxops/core";
import { ConflictError, NotFoundError } from "@taxops/services";
import { headers } from "next/headers";
import { sessionSubject } from "./auth";
import { log } from "./log";
import { clientKey, limiter } from "./rate-limit";

export type ActionResult<T = unknown> =
  | { ok: true; data?: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

/** Request limits for every server action, per person: 240 actions a minute overall and 40 a minute of any single kind. Far above
 *  normal use (a person clicking), far below what a script needs to flood notifications, spam requests or hammer the database. */
export const ACTION_LIMIT_ALL = 240;
export const ACTION_LIMIT_EACH = 40;

async function throttled(): Promise<boolean> {
  const h = await headers();
  const who = (await sessionSubject()) ?? `ip:${clientKey(h)}`;
  const id = h.get("next-action") ?? "none";
  const all = limiter("actions", ACTION_LIMIT_ALL, 60_000).hit(who).ok;
  const each = limiter(`action:${id}`, ACTION_LIMIT_EACH, 60_000).hit(who).ok;
  return !(all && each);
}

/** Converts domain errors into safe, user-facing results. Unknown errors are logged, never leaked. */
export async function guard<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    if (await throttled()) return { ok: false, error: "Too many requests. Please wait a moment and try again." };
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
