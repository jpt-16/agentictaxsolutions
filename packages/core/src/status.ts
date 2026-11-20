export const REQUEST_STATUSES = [
  "draft",
  "open",
  "in_progress",
  "changes_requested",
  "in_review",
  "approved",
  "closed",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const ITEM_STATUSES = ["pending", "submitted", "changes_requested", "approved"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const REQUEST_STATUS_LABELS: Record<RequestStatus, string> = {
  draft: "Draft",
  open: "Open",
  in_progress: "In progress",
  changes_requested: "Changes requested",
  in_review: "In review",
  approved: "Approved",
  closed: "Closed",
};

export const ITEM_STATUS_LABELS: Record<ItemStatus, string> = {
  pending: "Pending",
  submitted: "Submitted",
  changes_requested: "Changes requested",
  approved: "Approved",
};

export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransitionError";
  }
}

const ITEM_TRANSITIONS: Record<ItemStatus, readonly ItemStatus[]> = {
  pending: ["submitted"],
  submitted: ["approved", "changes_requested"],
  changes_requested: ["submitted"],
  approved: [],
};

export function assertItemTransition(from: ItemStatus, to: ItemStatus): void {
  if (!ITEM_TRANSITIONS[from].includes(to)) {
    throw new InvalidTransitionError(`Item cannot move from "${from}" to "${to}".`);
  }
}

/**
 * Request status is mostly *derived* from its items so it can never drift out of sync.
 * `draft` (before publishing) and `closed` (after sign-off) are explicit manager decisions.
 */
export function deriveRequestStatus(current: RequestStatus, items: readonly ItemStatus[]): RequestStatus {
  if (current === "draft" || current === "closed") return current;
  if (items.length === 0) return "open";
  if (items.every((s) => s === "approved")) return "approved";
  if (items.some((s) => s === "changes_requested")) return "changes_requested";
  const submittedOrDone = items.filter((s) => s === "submitted" || s === "approved").length;
  if (submittedOrDone === items.length) return "in_review";
  if (submittedOrDone > 0) return "in_progress";
  return "open";
}

export function assertCanPublish(status: RequestStatus, itemCount: number, assigneeCount: number): void {
  if (status !== "draft") throw new InvalidTransitionError("Only draft requests can be published.");
  if (itemCount === 0) throw new InvalidTransitionError("Add at least one information item before publishing.");
  if (assigneeCount === 0) throw new InvalidTransitionError("Assign the request to at least one department, entity or person before publishing.");
}

export function assertCanClose(status: RequestStatus): void {
  if (status !== "approved") throw new InvalidTransitionError("Only fully approved requests can be closed.");
}

/** Overdue is never stored; it is computed from the due date. Dates are ISO `YYYY-MM-DD`. */
export function isOverdue(dueDate: string, status: RequestStatus, today: string): boolean {
  if (status === "approved" || status === "closed" || status === "draft") return false;
  return dueDate < today;
}

export function daysUntil(dueDate: string, today: string): number {
  const ms = Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
