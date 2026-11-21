import { z } from "zod";

export const PRIORITIES = ["low", "medium", "high"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const DATA_TYPES = [
  "trial_balance",
  "fixed_asset_register",
  "intercompany",
  "transfer_pricing",
  "rd_credit",
  "narrative",
  "other",
] as const;
export type DataType = (typeof DATA_TYPES)[number];

export const DATA_TYPE_LABELS: Record<DataType, string> = {
  trial_balance: "Trial balance",
  fixed_asset_register: "Fixed asset register",
  intercompany: "Intercompany balances",
  transfer_pricing: "Transfer pricing data",
  rd_credit: "R&D credit data",
  narrative: "Narrative / explanation",
  other: "Other",
};

/**
 * Text that is safe to store and show: no NUL or other control characters (PostgreSQL rejects NUL outright, and the rest corrupt
 * displays and exports). Tabs and newlines are allowed in multi-line fields, so the rule excludes only the dangerous ones.
 */
export const NO_CONTROL_CHARS = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/;
export const NO_CONTROL_MESSAGE = "Contains characters that are not allowed";
/** A calendar date that really exists: "2027-02-30" parses in JavaScript (as 2 March) but is not a date. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD").refine((s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}, "Invalid date");

export const assigneeSchema = z.object({
  type: z.enum(["department", "entity", "user"]),
  id: z.string().uuid(),
});

export const itemInputSchema = z.object({
  title: z.string().regex(NO_CONTROL_CHARS, NO_CONTROL_MESSAGE).trim().min(3, "Give the item a short title").max(200),
  description: z.string().regex(NO_CONTROL_CHARS, NO_CONTROL_MESSAGE).trim().max(2000).optional().default(""),
  dataType: z.enum(DATA_TYPES),
  required: z.boolean().default(true),
});

export const createRequestSchema = z.object({
  title: z.string().regex(NO_CONTROL_CHARS, NO_CONTROL_MESSAGE).trim().min(5, "Title must be at least 5 characters").max(200),
  description: z.string().regex(NO_CONTROL_CHARS, NO_CONTROL_MESSAGE).trim().max(5000).optional().default(""),
  taxYear: z.coerce.number().int().min(2000).max(2100),
  dueDate: isoDate,
  priority: z.enum(PRIORITIES).default("medium"),
  items: z.array(itemInputSchema).max(100).default([]),
  assignees: z.array(assigneeSchema).max(100).default([]),
});
export type CreateRequestInput = z.infer<typeof createRequestSchema>;

export const submitItemSchema = z.object({
  note: z.string().regex(NO_CONTROL_CHARS, NO_CONTROL_MESSAGE).trim().min(3, "Add a short note describing what you are submitting").max(2000),
});

export const reviewItemSchema = z.object({
  decision: z.enum(["approved", "changes_requested"]),
  rationale: z.string().regex(NO_CONTROL_CHARS, NO_CONTROL_MESSAGE).trim().max(2000).default(""),
}).refine((v) => v.decision === "approved" || v.rationale.length >= 3, {
  message: "Explain what needs to change",
  path: ["rationale"],
});

export const commentSchema = z.object({
  body: z.string().regex(NO_CONTROL_CHARS, NO_CONTROL_MESSAGE).trim().min(1, "Comment cannot be empty").max(4000),
  itemId: z.string().uuid().optional(),
});
