/** Structured JSON logging. One line per event, machine-parseable, with sensitive-looking fields redacted and long strings clipped. */
export type Level = "debug" | "info" | "warn" | "error";

const SENSITIVE = /pass(word)?|secret|token|authorization|cookie|session|signature|api[-_]?key|code[-_]?verifier|^note$|^body$|rationale/i;
const MAX = 500;

export function sanitize(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > MAX ? `${value.slice(0, MAX)}…[${value.length - MAX} more]` : value;
  if (value instanceof Error) return { name: value.name, message: sanitize(value.message), ...(value.cause ? { cause: sanitize(String((value.cause as Error).message ?? value.cause)) } : {}) };
  if (depth > 3) return "[nested]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE.test(k) ? "[redacted]" : sanitize(v, depth + 1)]));
  }
  return String(value);
}

export function formatLog(level: Level, msg: string, fields: Record<string, unknown> = {}, now: Date = new Date()): string {
  return JSON.stringify({ ts: now.toISOString(), level, msg, ...(sanitize(fields) as object) });
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => { if (process.env.LOG_LEVEL === "debug") console.debug(formatLog("debug", msg, f)); },
  info: (msg: string, f?: Record<string, unknown>) => console.info(formatLog("info", msg, f)),
  warn: (msg: string, f?: Record<string, unknown>) => console.warn(formatLog("warn", msg, f)),
  error: (msg: string, f?: Record<string, unknown>) => console.error(formatLog("error", msg, f)),
};

/** Request id from the proxy header (or a fresh one), so a user-visible failure can be matched to one log line. */
export function requestIdFrom(headers: { get(name: string): string | null }): string {
  const incoming = headers.get("x-request-id");
  return incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
}
