import { z } from "zod";

export const PROPOSAL_STATUSES = ["pending", "accepted", "rejected", "superseded"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export const PROPOSAL_STATUS_LABELS: Record<ProposalStatus, string> = {
  pending: "Awaiting review", accepted: "Accepted", rejected: "Rejected", superseded: "Superseded",
};

/**
 * Shape of an extraction proposal's payload, as produced by the Python agent (services/agent-worker).
 * `schemas/fixtures/extraction_proposal.json` is a golden sample checked from both sides, so the two cannot drift silently.
 * Treat it as untrusted: it is derived from user-uploaded spreadsheets.
 */
export const extractionPayloadSchema = z.object({
  schema: z.string(),
  schema_version: z.string(),
  sheet: z.string(),
  method: z.enum(["heuristic", "llm"]),
  header_row: z.number().int(),
  fields: z.array(z.object({ key: z.string(), label: z.string() })),
  columns: z.record(z.string(), z.object({ letter: z.string(), header: z.string() })),
  stats: z.object({
    row_count: z.number().int(),
    sum_debit: z.string(),
    sum_credit: z.string(),
    reported_total_debit: z.string().nullable(),
    reported_total_credit: z.string().nullable(),
    unparsed_cells: z.number().int(),
    rows_with_issues: z.number().int(),
    totals_mismatch: z.boolean().optional(),
  }),
  metadata: z.record(z.string(), z.string()),
  notes: z.array(z.string()),
  parse_rate: z.number(),
  file_id: z.string(),
});
export type ExtractionPayload = z.infer<typeof extractionPayloadSchema>;

export const decideProposalSchema = z
  .object({
    decision: z.enum(["accepted", "rejected"]),
    note: z.string().trim().max(2000).default(""),
  })
  .refine((v) => v.decision === "accepted" || v.note.length >= 3, { message: "Explain why you are rejecting this result", path: ["note"] });

export type ConfidenceBand = "high" | "medium" | "low";
/** Presentation bands only; they never gate anything. A human reviews every proposal regardless. */
export function confidenceBand(c: number): ConfidenceBand {
  return c >= 0.9 ? "high" : c >= 0.75 ? "medium" : "low";
}

export type ProposalKind = "extraction" | "finding";
/** Findings are "confirmed" or "dismissed"; extractions are "accepted" or "rejected". Same underlying statuses. */
export function proposalStatusLabel(kind: ProposalKind, status: ProposalStatus): string {
  if (kind === "finding") return { pending: "Open", accepted: "Confirmed", rejected: "Dismissed", superseded: "Superseded" }[status];
  return PROPOSAL_STATUS_LABELS[status];
}

export const findingPayloadSchema = z.object({
  schema: z.string(),
  sheet: z.string(),
  rule_id: z.string(),
  rule_name: z.string(),
  summary: z.string(),
  explanation: z.string(),
  explanation_source: z.enum(["template", "llm"]),
  suggestion: z.string(),
  evidence: z.array(z.object({ row: z.number().int(), sheet: z.string(), cells: z.array(z.string()), note: z.string() })),
  metrics: z.record(z.string(), z.unknown()),
  dedupe: z.string(),
  source_proposal_id: z.string(),
});
export type FindingPayload = z.infer<typeof findingPayloadSchema>;
