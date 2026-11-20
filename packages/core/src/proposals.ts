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
