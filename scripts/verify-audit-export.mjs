#!/usr/bin/env node
/**
 * Offline verifier for an audit export (JSON). Needs only Node: no database, no application.
 *   node scripts/verify-audit-export.mjs export.json
 * Checks, for every event: SHA-256(canonical text) === hash; the canonical text embeds the stated previous hash and sequence;
 * the visible fields match what was hashed; consecutive events link; an unfiltered export has no gaps and starts at the genesis.
 * Exit code 0 = intact, 1 = tampering or inconsistency detected, 2 = unusable input.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const file = process.argv[2];
if (!file) { console.error("Usage: node scripts/verify-audit-export.mjs <export.json>"); process.exit(2); }
let exp;
try { exp = JSON.parse(readFileSync(file, "utf8")); } catch (e) { console.error(`Cannot read ${file}: ${e.message}`); process.exit(2); }
if (!exp?.events || !Array.isArray(exp.events)) { console.error("Not an audit export (no events array)."); process.exit(2); }

const GENESIS = "0".repeat(64);
const filtered = !!exp.meta && Object.values(exp.meta.filters ?? {}).some(Boolean);
const problems = [];
let prev = null;
for (const e of exp.events) {
  const at = `event #${e.seq}`;
  let c;
  try { c = JSON.parse(e.canonical); } catch { problems.push(`${at}: canonical text is not valid JSON`); prev = e; continue; }
  const sha = createHash("sha256").update(e.canonical, "utf8").digest("hex");
  if (sha !== e.hash) problems.push(`${at}: hash does not match its canonical text (altered after the fact)`);
  if (c[0] !== e.prev_hash) problems.push(`${at}: canonical text embeds a different previous hash`);
  if (c[2] !== e.seq) problems.push(`${at}: canonical sequence ${c[2]} differs from ${e.seq}`);
  if (String(c[3]).slice(0, 19) !== String(e.occurred_at).slice(0, 19)) problems.push(`${at}: timestamp differs from the hashed value`);
  if (c[6] !== e.actor_label || c[7] !== e.action || c[8] !== e.entity_type || c[11] !== e.summary) problems.push(`${at}: visible fields (actor/action/entity/summary) differ from the hashed values`);
  if (!isDeepStrictEqual(c[12], e.before ?? null) || !isDeepStrictEqual(c[13], e.after ?? null)) problems.push(`${at}: before/after differ from the hashed values`);
  if (prev) {
    if (e.seq === prev.seq + 1 && e.prev_hash !== prev.hash) problems.push(`${at}: does not link to the previous event (chain broken)`);
    if (!filtered && e.seq !== prev.seq + 1) problems.push(`${at}: gap in sequence after #${prev.seq} (events removed or reordered)`);
  } else if (!filtered && e.seq === 1 && e.prev_hash !== GENESIS) problems.push(`${at}: first event does not start from the genesis hash`);
  prev = e;
}
if (!filtered && exp.events.length && exp.events[0].seq !== 1 && exp.meta?.complete !== false) problems.push(`export does not start at event #1`);

if (problems.length) {
  console.error(`INTEGRITY FAILURE: ${problems.length} problem(s) in ${exp.events.length} event(s):`);
  for (const p of problems.slice(0, 20)) console.error("  - " + p);
  process.exit(1);
}
console.log(`OK: ${exp.events.length} event(s) verified${filtered ? " (filtered export: links checked only between consecutive events)" : ", contiguous from the genesis hash"}.`);
