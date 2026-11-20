export const ROLES = ["tenant_admin", "tax_manager", "tax_reviewer", "contributor", "auditor"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  tenant_admin: "Tenant Admin",
  tax_manager: "Tax Manager",
  tax_reviewer: "Tax Reviewer",
  contributor: "Contributor",
  auditor: "Auditor",
};

export const PERMISSIONS = [
  "dashboard.read",
  "request.read.all", // see every request in the tenant
  "request.read.assigned", // see only requests assigned to me / my department / my entity
  "request.create",
  "request.update",
  "request.publish",
  "request.close",
  "item.submit",
  "item.review",
  "comment.create",
  "audit.read",
  "user.read",
  "proposal.read", // see AI-generated proposals
  "proposal.review", // accept or reject them
  "rules.manage", // switch validation rules on/off and tune them
  "tenant.admin", // users and tenant-level AI switches
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const MATRIX: Record<Role, readonly Permission[]> = {
  tenant_admin: ["dashboard.read", "request.read.all", "audit.read", "user.read", "proposal.read", "rules.manage", "tenant.admin"],
  tax_manager: [
    "dashboard.read",
    "request.read.all",
    "request.create",
    "request.update",
    "request.publish",
    "request.close",
    "item.review",
    "comment.create",
    "audit.read",
    "user.read",
    "proposal.read",
    "proposal.review",
    "rules.manage",
  ],
  tax_reviewer: ["dashboard.read", "request.read.all", "item.review", "comment.create", "user.read", "proposal.read", "proposal.review"],
  contributor: ["dashboard.read", "request.read.assigned", "item.submit", "comment.create"],
  auditor: ["dashboard.read", "request.read.all", "audit.read", "user.read", "proposal.read"],
};

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role].includes(permission);
}

export function permissionsFor(role: Role): readonly Permission[] {
  return MATRIX[role];
}

export class ForbiddenError extends Error {
  constructor(message = "You do not have permission to perform this action.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export function assertCan(role: Role, permission: Permission): void {
  if (!can(role, permission)) throw new ForbiddenError(`Missing permission: ${permission}`);
}

/** Who is performing an action, as far as authorization is concerned. */
export interface Actor {
  userId: string;
  tenantId: string;
  role: Role;
  departmentId: string | null;
  entityId: string | null;
}

export type AssigneeType = "department" | "entity" | "user";
export interface AssigneeRef {
  type: AssigneeType;
  id: string;
}

/**
 * Attribute-based scope check layered on top of RBAC.
 * Roles with `request.read.all` see everything in their tenant; contributors only see
 * requests assigned to them directly, to their department, or to their legal entity.
 */
export function canViewRequest(actor: Actor, assignees: readonly AssigneeRef[]): boolean {
  if (can(actor.role, "request.read.all")) return true;
  if (!can(actor.role, "request.read.assigned")) return false;
  return assignees.some(
    (a) =>
      (a.type === "user" && a.id === actor.userId) ||
      (a.type === "department" && actor.departmentId !== null && a.id === actor.departmentId) ||
      (a.type === "entity" && actor.entityId !== null && a.id === actor.entityId),
  );
}

/** Segregation of duties: nobody reviews their own submission. */
export function violatesSegregationOfDuties(reviewerId: string, submitterId: string): boolean {
  return reviewerId === submitterId;
}
