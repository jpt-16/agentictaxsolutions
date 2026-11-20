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

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD").refine((s) => !Number.isNaN(Date.parse(s)), "Invalid date");

export const assigneeSchema = z.object({
  type: z.enum(["department", "entity", "user"]),
  id: z.string().uuid(),
});

export const itemInputSchema = z.object({
  title: z.string().trim().min(3, "Give the item a short title").max(200),
  description: z.string().trim().max(2000).optional().default(""),
  dataType: z.enum(DATA_TYPES),
  required: z.boolean().default(true),
});

export const createRequestSchema = z.object({
  title: z.string().trim().min(5, "Title must be at least 5 characters").max(200),
  description: z.string().trim().max(5000).optional().default(""),
  taxYear: z.coerce.number().int().min(2000).max(2100),
  dueDate: isoDate,
  priority: z.enum(PRIORITIES).default("medium"),
  items: z.array(itemInputSchema).max(100).default([]),
  assignees: z.array(assigneeSchema).max(100).default([]),
});
export type CreateRequestInput = z.infer<typeof createRequestSchema>;

export const submitItemSchema = z.object({
  note: z.string().trim().min(3, "Add a short note describing what you are submitting").max(2000),
});

export const reviewItemSchema = z.object({
  decision: z.enum(["approved", "changes_requested"]),
  rationale: z.string().trim().max(2000).default(""),
}).refine((v) => v.decision === "approved" || v.rationale.length >= 3, {
  message: "Explain what needs to change",
  path: ["rationale"],
});

export const commentSchema = z.object({
  body: z.string().trim().min(1, "Comment cannot be empty").max(4000),
  itemId: z.string().uuid().optional(),
});
