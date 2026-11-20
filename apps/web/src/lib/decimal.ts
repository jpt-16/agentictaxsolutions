/** Exact decimal helpers for display. Amounts arrive as strings; they are never converted to floating point. */
const RE = /^-?\d+(\.\d+)?$/;

function parts(s: string) {
  if (!RE.test(s)) return null;
  const neg = s.startsWith("-");
  const [i, f = ""] = (neg ? s.slice(1) : s).split(".");
  return { neg, i: i!, f };
}

export function formatAmount(s: string | null | undefined): string {
  if (s == null) return "—";
  const p = parts(s);
  if (!p) return s;
  const grouped = p.i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${p.neg && (p.i !== "0" || /[1-9]/.test(p.f)) ? "-" : ""}${grouped}${p.f ? "." + p.f : ""}`;
}

/** a - b, exactly, as a plain decimal string ("0" when equal). */
export function decimalDiff(a: string, b: string): string {
  const pa = parts(a), pb = parts(b);
  if (!pa || !pb) return "0";
  const k = Math.max(pa.f.length, pb.f.length);
  const big = (p: NonNullable<typeof pa>) => (p.neg ? -1n : 1n) * BigInt(p.i + p.f.padEnd(k, "0"));
  const d = big(pa) - big(pb);
  const neg = d < 0n;
  const digits = (neg ? -d : d).toString().padStart(k + 1, "0");
  const whole = digits.slice(0, digits.length - k), frac = digits.slice(digits.length - k).replace(/0+$/, "");
  const out = frac ? `${whole}.${frac}` : whole;
  return out === "0" ? "0" : neg ? `-${out}` : out;
}
