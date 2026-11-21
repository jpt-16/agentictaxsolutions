/** Finds "@Full Name" mentions of known people in a comment. Matches whole names only, longest first, case-insensitive. */
export function mentionedUsers<T extends { id: string; name: string }>(body: string, people: readonly T[]): T[] {
  const out: T[] = [];
  const taken: [number, number][] = [];
  const lower = body.toLowerCase();
  for (const p of [...people].sort((a, b) => b.name.length - a.name.length)) {
    const needle = `@${p.name.toLowerCase()}`;
    let from = 0;
    for (;;) {
      const i = lower.indexOf(needle, from);
      if (i < 0) break;
      const end = i + needle.length;
      const before = i === 0 || !/[\w@]/.test(lower[i - 1]!);        // not part of an email address or another word
      const after = end >= lower.length || !/[\p{L}\p{N}_]/u.test(lower[end]!); // whole name, not a prefix of a longer one
      const overlaps = taken.some(([a, b]) => i < b && end > a);
      if (before && after && !overlaps) { taken.push([i, end]); if (!out.includes(p)) out.push(p); break; }
      from = i + 1;
    }
  }
  return out;
}
