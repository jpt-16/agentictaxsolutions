/**
 * Which legal entity does a trial balance belong to?
 *
 * Plain string matching and set logic, no model. Three kinds of evidence are weighed:
 *   - the request's assignment (which entities the request was sent to),
 *   - the uploader's own entity,
 *   - text inside the file (sheet name, title rows, file name) that names an entity.
 * The result is a SUGGESTION. A reviewer confirms or changes it, and nothing is final until then. When the evidence disagrees, the
 * status is "conflict" and the reviewer must choose; the function never picks silently.
 */

export interface EntityRef { id: string; code: string; name: string }
export type EntitySource = "assignment" | "uploader" | "file" | "reviewer";
export interface EntityGuess { entity: EntityRef; source: Exclude<EntitySource, "reviewer">; why: string }
export interface EntityResolution {
  status: "suggested" | "conflict" | "unknown";
  suggestion: EntityGuess | null;
  /** What the file's own text names, when it names exactly one entity. */
  detected: EntityRef | null;
  note: string;
}

// Words that only say what kind of company it is. Dropped so "Northwind GmbH" is recognised as "Northwind" in a title.
const LEGAL_FORMS = new Set(["gmbh", "ag", "sas", "sarl", "sa", "ltd", "limited", "llc", "inc", "corp", "corporation", "plc", "bv", "nv", "pty", "pte", "kk", "co", "company", "srl", "spa", "oy", "ab", "as", "ltda", "ulc", "lp", "llp", "de", "cv", "holdings", "group"]);

export function normalizeText(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function coreTokens(name: string): string[] {
  const all = normalizeText(name).split(" ").filter(Boolean);
  const core = all.filter((t) => !LEGAL_FORMS.has(t));
  return core.length ? core : all;
}

/** True when the tokens appear as one contiguous phrase in the text (so "northwind france" is not found in "northwind germany france"). */
function hasPhrase(text: string, tokens: string[]): boolean {
  if (!tokens.length) return false;
  return (` ${text} `).includes(` ${tokens.join(" ")} `);
}

/**
 * The single entity the texts name, or null when they name none or several equally well.
 * A brand shared by every entity ("Northwind") does not identify any one of them, so for an entity whose name is only the shared brand
 * the legal form must be present too ("Northwind GmbH"). Otherwise the full name scores highest, and the distinctive part alone ("France") scores lower.
 */
export function detectEntity(entities: EntityRef[], texts: string[]): { entity: EntityRef | null; ambiguous: EntityRef[] } {
  const hay = texts.map(normalizeText).filter(Boolean).join(" | ");
  if (!hay) return { entity: null, ambiguous: [] };
  const df = new Map<string, number>();
  for (const e of entities) for (const t of new Set(coreTokens(e.name))) df.set(t, (df.get(t) ?? 0) + 1);
  const scored: { e: EntityRef; score: number }[] = [];
  for (const e of entities) {
    const full = coreTokens(e.name);
    const distinct = entities.length > 1 ? full.filter((t) => (df.get(t) ?? 0) < entities.length) : full;
    let score = 0;
    if (distinct.length === 0) {
      const all = normalizeText(e.name).split(" ").filter(Boolean);
      score = hasPhrase(hay, all) ? all.length * 2 : 0;
    } else if (hasPhrase(hay, full)) score = full.length * 2;
    else if (hasPhrase(hay, distinct)) score = distinct.length;
    const code = normalizeText(e.code);
    if (code.length >= 3 && !code.includes(" ") && hasPhrase(hay, [code])) score = Math.max(score, 2);
    if (score > 0) scored.push({ e, score });
  }
  if (!scored.length) return { entity: null, ambiguous: [] };
  const best = Math.max(...scored.map((x) => x.score));
  const top = scored.filter((x) => x.score === best).map((x) => x.e);
  return top.length === 1 ? { entity: top[0]!, ambiguous: [] } : { entity: null, ambiguous: top };
}

export interface ResolveInput {
  entities: EntityRef[];
  /** Entities the request was assigned to (assignment type "entity"). */
  assignedEntityIds: string[];
  uploaderEntityId: string | null;
  /** Sheet name, title rows and file name. */
  texts: string[];
}

export function resolveEntity(input: ResolveInput): EntityResolution {
  const byId = new Map(input.entities.map((e) => [e.id, e]));
  const assigned = [...new Set(input.assignedEntityIds)].map((id) => byId.get(id)).filter((e): e is EntityRef => !!e);
  const uploader = input.uploaderEntityId ? byId.get(input.uploaderEntityId) ?? null : null;
  const { entity: detected, ambiguous } = detectEntity(input.entities, input.texts);
  const label = (e: EntityRef) => `${e.name} (${e.code})`;

  if (detected) {
    if (assigned.length && !assigned.some((a) => a.id === detected.id)) {
      return {
        status: "conflict", detected,
        suggestion: { entity: detected, source: "file", why: `The file names ${label(detected)}.` },
        note: `The file names ${label(detected)}, but this request was sent to ${assigned.map(label).join(", ")}. Check that the right file was uploaded, then choose the entity.`,
      };
    }
    const upNote = uploader && uploader.id !== detected.id ? ` The uploader belongs to ${label(uploader)}.` : "";
    return { status: "suggested", detected, suggestion: { entity: detected, source: "file", why: `The file names ${label(detected)}.${upNote}` }, note: `Taken from the text in the file.${upNote}` };
  }

  const ambiguousNote = ambiguous.length ? ` The file mentions several entities (${ambiguous.map((e) => e.code).join(", ")}), so none was assumed.` : "";
  if (assigned.length === 1) {
    return { status: "suggested", detected: null, suggestion: { entity: assigned[0]!, source: "assignment", why: `The request was sent only to ${label(assigned[0]!)}.` }, note: `The file does not say which entity it is for.${ambiguousNote}` };
  }
  if (uploader && (assigned.length === 0 || assigned.some((a) => a.id === uploader.id))) {
    return { status: "suggested", detected: null, suggestion: { entity: uploader, source: "uploader", why: `The uploader belongs to ${label(uploader)}.` }, note: `The file does not say which entity it is for, so this is based on who uploaded it.${ambiguousNote}` };
  }
  return { status: "unknown", detected: null, suggestion: null, note: `Nothing in the request or the file says which entity this is. Choose one.${ambiguousNote}` };
}
