import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertCan, assertCanClose, assertCanPublish, assertItemTransition, canViewRequest, can, daysUntil,
  deriveRequestStatus, isOverdue, violatesSegregationOfDuties, createRequestSchema, reviewItemSchema,
  ForbiddenError, InvalidTransitionError, type Actor, extractionPayloadSchema, decideProposalSchema, confidenceBand,
} from "./index";

const actor = (over: Partial<Actor> = {}): Actor => ({
  userId: "u1", tenantId: "t1", role: "contributor", departmentId: "d1", entityId: "e1", ...over,
});

describe("RBAC", () => {
  it("lets managers create requests but not contributors, auditors or reviewers", () => {
    expect(can("tax_manager", "request.create")).toBe(true);
    for (const r of ["contributor", "auditor", "tax_reviewer", "tenant_admin"] as const) {
      expect(can(r, "request.create")).toBe(false);
    }
  });
  it("only contributors submit; only managers/reviewers review", () => {
    expect(can("contributor", "item.submit")).toBe(true);
    expect(can("tax_manager", "item.submit")).toBe(false);
    expect(can("tax_reviewer", "item.review")).toBe(true);
    expect(can("contributor", "item.review")).toBe(false);
    expect(can("auditor", "item.review")).toBe(false);
  });
  it("only audit-capable roles read the audit trail", () => {
    expect(can("contributor", "audit.read")).toBe(false);
    expect(can("tax_reviewer", "audit.read")).toBe(false);
    expect(can("auditor", "audit.read")).toBe(true);
  });
  it("assertCan throws ForbiddenError", () => {
    expect(() => assertCan("contributor", "request.create")).toThrow(ForbiddenError);
  });
});

describe("request visibility (ABAC)", () => {
  it("contributors see only requests assigned to them, their department or their entity", () => {
    expect(canViewRequest(actor(), [{ type: "department", id: "d1" }])).toBe(true);
    expect(canViewRequest(actor(), [{ type: "entity", id: "e1" }])).toBe(true);
    expect(canViewRequest(actor(), [{ type: "user", id: "u1" }])).toBe(true);
    expect(canViewRequest(actor(), [{ type: "department", id: "d2" }, { type: "entity", id: "e2" }])).toBe(false);
    expect(canViewRequest(actor(), [])).toBe(false);
  });
  it("a contributor without a department does not match a null department", () => {
    expect(canViewRequest(actor({ departmentId: null }), [{ type: "department", id: "null" }])).toBe(false);
  });
  it("managers and auditors see everything in the tenant", () => {
    expect(canViewRequest(actor({ role: "tax_manager" }), [])).toBe(true);
    expect(canViewRequest(actor({ role: "auditor" }), [])).toBe(true);
  });
  it("segregation of duties blocks self-review", () => {
    expect(violatesSegregationOfDuties("u1", "u1")).toBe(true);
    expect(violatesSegregationOfDuties("u2", "u1")).toBe(false);
  });
});

describe("status machine", () => {
  it("derives request status from items", () => {
    expect(deriveRequestStatus("open", ["pending", "pending"])).toBe("open");
    expect(deriveRequestStatus("open", ["submitted", "pending"])).toBe("in_progress");
    expect(deriveRequestStatus("in_progress", ["submitted", "approved"])).toBe("in_review");
    expect(deriveRequestStatus("in_review", ["approved", "approved"])).toBe("approved");
    expect(deriveRequestStatus("in_review", ["changes_requested", "submitted"])).toBe("changes_requested");
  });
  it("never moves draft or closed requests on its own", () => {
    expect(deriveRequestStatus("draft", ["approved"])).toBe("draft");
    expect(deriveRequestStatus("closed", ["pending"])).toBe("closed");
  });
  it("validates item transitions", () => {
    expect(() => assertItemTransition("pending", "submitted")).not.toThrow();
    expect(() => assertItemTransition("pending", "approved")).toThrow(InvalidTransitionError);
    expect(() => assertItemTransition("approved", "submitted")).toThrow(InvalidTransitionError);
    expect(() => assertItemTransition("changes_requested", "submitted")).not.toThrow();
  });
  it("guards publish and close", () => {
    expect(() => assertCanPublish("draft", 1, 1)).not.toThrow();
    expect(() => assertCanPublish("draft", 0, 1)).toThrow(InvalidTransitionError);
    expect(() => assertCanPublish("draft", 1, 0)).toThrow(InvalidTransitionError);
    expect(() => assertCanPublish("open", 1, 1)).toThrow(InvalidTransitionError);
    expect(() => assertCanClose("approved")).not.toThrow();
    expect(() => assertCanClose("in_review")).toThrow(InvalidTransitionError);
  });
  it("computes overdue and days-until without storing them", () => {
    expect(isOverdue("2025-01-01", "open", "2025-01-02")).toBe(true);
    expect(isOverdue("2025-01-02", "open", "2025-01-02")).toBe(false);
    expect(isOverdue("2025-01-01", "approved", "2025-06-01")).toBe(false);
    expect(isOverdue("2025-01-01", "draft", "2025-06-01")).toBe(false);
    expect(daysUntil("2025-01-10", "2025-01-01")).toBe(9);
    expect(daysUntil("2025-01-01", "2025-01-10")).toBe(-9);
  });
});

describe("input validation", () => {
  const base = { title: "Q4 trial balances", taxYear: 2025, dueDate: "2026-03-15", priority: "high", items: [], assignees: [] };
  it("accepts a valid request and applies defaults", () => {
    const r = createRequestSchema.parse(base);
    expect(r.description).toBe("");
  });
  it("rejects bad dates, short titles and non-uuid assignees", () => {
    expect(createRequestSchema.safeParse({ ...base, dueDate: "15/03/2026" }).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...base, dueDate: "2026-13-45" }).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...base, title: "abc" }).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...base, assignees: [{ type: "user", id: "nope" }] }).success).toBe(false);
  });
  it("requires a rationale when requesting changes", () => {
    expect(reviewItemSchema.safeParse({ decision: "changes_requested", rationale: "" }).success).toBe(false);
    expect(reviewItemSchema.safeParse({ decision: "approved" }).success).toBe(true);
  });
});

describe("AI proposals", () => {
  it("only reviewers/managers can decide; contributors never see proposals; auditors can read but not decide", () => {
    for (const r of ["tax_manager", "tax_reviewer"] as const) { expect(can(r, "proposal.read")).toBe(true); expect(can(r, "proposal.review")).toBe(true); }
    for (const r of ["auditor", "tenant_admin"] as const) { expect(can(r, "proposal.read")).toBe(true); expect(can(r, "proposal.review")).toBe(false); }
    expect(can("contributor", "proposal.read")).toBe(false);
    expect(can("contributor", "proposal.review")).toBe(false);
  });

  it("parses the golden payload produced by the Python agent (contract parity)", () => {
    const golden = JSON.parse(readFileSync(resolve(__dirname, "../../../schemas/fixtures/extraction_proposal.json"), "utf8"));
    const payload = extractionPayloadSchema.parse(golden.proposal.payload);
    expect(payload.stats.row_count).toBe(6);
    expect(payload.columns.debit).toEqual({ letter: "C", header: "Debit" });
    expect(golden.first_row.cells.debit).toBe("C4");
  });

  it("rejects payloads that drift from the contract", () => {
    const golden = JSON.parse(readFileSync(resolve(__dirname, "../../../schemas/fixtures/extraction_proposal.json"), "utf8"));
    expect(extractionPayloadSchema.safeParse({ ...golden.proposal.payload, method: "magic" }).success).toBe(false);
    expect(extractionPayloadSchema.safeParse({ ...golden.proposal.payload, stats: { row_count: 1 } }).success).toBe(false);
  });

  it("requires a reason to reject, and bands confidence for display only", () => {
    expect(decideProposalSchema.safeParse({ decision: "rejected", note: "" }).success).toBe(false);
    expect(decideProposalSchema.safeParse({ decision: "rejected", note: "Wrong mapping" }).success).toBe(true);
    expect(decideProposalSchema.safeParse({ decision: "accepted" }).success).toBe(true);
    expect([0.95, 0.8, 0.5].map(confidenceBand)).toEqual(["high", "medium", "low"]);
  });
});
