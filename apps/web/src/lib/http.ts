import "server-only";
import { ZodError } from "zod";
import { ForbiddenError, InvalidTransitionError } from "@taxops/core";
import { ConflictError, NotFoundError, UploadRejectedError } from "@taxops/services";
import { log } from "./log";

/** Maps domain errors to safe JSON responses. Unknown errors are logged and returned as a generic 500. */
export function errorResponse(e: unknown): Response {
  if (e instanceof ZodError) return Response.json({ ok: false, error: e.issues[0]?.message ?? "Invalid input." }, { status: 400 });
  if (e instanceof ForbiddenError) return Response.json({ ok: false, error: e.message }, { status: 403 });
  if (e instanceof NotFoundError) return Response.json({ ok: false, error: e.message }, { status: 404 });
  if (e instanceof InvalidTransitionError || e instanceof ConflictError) return Response.json({ ok: false, error: e.message }, { status: 409 });
  if (e instanceof UploadRejectedError) return Response.json({ ok: false, error: e.message, reasons: e.reasons }, { status: 422 });
  log.error("unhandled route error", { error: e });
  return Response.json({ ok: false, error: "Something went wrong. Please try again." }, { status: 500 });
}

/** CSRF defence for cookie-authenticated mutations outside server actions (which Next protects itself). */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}
