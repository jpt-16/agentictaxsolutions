import { sql } from "drizzle-orm";
import type { Tx } from "./client";

export interface AuditActor {
  type: "user" | "agent" | "system";
  id: string | null;
  label: string;
}

export interface AuditInput {
  tenantId: string;
  actor: AuditActor;
  /** Dotted verb, e.g. `request.created`, `item.approved`. */
  action: string;
  entityType: string;
  entityId: string | null;
  /** The request this event belongs to, for per-request history views. */
  requestRef?: string | null;
  summary: string;
  before?: unknown;
  after?: unknown;
}

/**
 * Appends an audit event inside the caller's transaction, so a change and its audit record
 * commit or roll back together. seq / timestamp / hash are assigned by the database trigger.
 */
export async function recordAudit(tx: Tx, e: AuditInput): Promise<void> {
  const before = e.before === undefined || e.before === null ? null : JSON.stringify(e.before);
  const after = e.after === undefined || e.after === null ? null : JSON.stringify(e.after);
  await tx.execute(sql`
    insert into audit_events
      (tenant_id, seq, actor_type, actor_id, actor_label, action, entity_type, entity_id, request_ref, summary, before, after, prev_hash, hash)
    values
      (${e.tenantId}, 0, ${e.actor.type}, ${e.actor.id}, ${e.actor.label}, ${e.action}, ${e.entityType},
       ${e.entityId}, ${e.requestRef ?? null}, ${e.summary}, ${before}::jsonb, ${after}::jsonb, '', '')`);
}

export async function verifyAuditChain(tx: Tx, tenantId: string) {
  const res = await tx.execute(sql`select ok, broken_seq, checked from verify_audit_chain(${tenantId})`);
  const row = res.rows[0] as { ok: boolean; broken_seq: string | null; checked: string };
  return { ok: row.ok, brokenSeq: row.broken_seq === null ? null : Number(row.broken_seq), checked: Number(row.checked) };
}
