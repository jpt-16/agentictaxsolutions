import {
  bigint, boolean, check, date, foreignKey, index, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { DATA_TYPES, ITEM_STATUSES, PRIORITIES, REQUEST_STATUSES, ROLES } from "@taxops/core";

/**
 * Tenant isolation rules for this schema (enforced again by RLS in the migrations):
 *  - every table except `tenants` carries `tenant_id`;
 *  - every parent/child relationship is a COMPOSITE foreign key (tenant_id, id), so a row can
 *    never point at a parent that belongs to a different tenant, even if its UUID is known.
 */

export const roleEnum = pgEnum("role", ROLES);
export const requestStatusEnum = pgEnum("request_status", REQUEST_STATUSES);
export const itemStatusEnum = pgEnum("item_status", ITEM_STATUSES);
export const priorityEnum = pgEnum("priority", PRIORITIES);
export const dataTypeEnum = pgEnum("data_type", DATA_TYPES);
export const assigneeTypeEnum = pgEnum("assignee_type", ["department", "entity", "user"]);
export const reviewDecisionEnum = pgEnum("review_decision", ["approved", "changes_requested"]);
export const jobStatusEnum = pgEnum("job_status", ["queued", "running", "succeeded", "dead"]);
export const actorTypeEnum = pgEnum("actor_type", ["user", "agent", "system"]);

const id = () => uuid("id").primaryKey().defaultRandom();
const tenantId = () => uuid("tenant_id").notNull();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const tenants = pgTable("tenants", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: createdAt(),
});

export const legalEntities = pgTable(
  "legal_entities",
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    name: text("name").notNull(),
    code: text("code").notNull(),
    country: text("country").notNull(),
    currency: text("currency").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("legal_entities_tenant_id_id").on(t.tenantId, t.id), unique("legal_entities_tenant_code").on(t.tenantId, t.code)],
);

export const departments = pgTable(
  "departments",
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    name: text("name").notNull(),
    code: text("code").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("departments_tenant_id_id").on(t.tenantId, t.id), unique("departments_tenant_code").on(t.tenantId, t.code)],
);

export const users = pgTable(
  "users",
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    title: text("title").notNull().default(""),
    role: roleEnum("role").notNull(),
    departmentId: uuid("department_id"),
    entityId: uuid("entity_id"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique("users_tenant_id_id").on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.departmentId], foreignColumns: [departments.tenantId, departments.id], name: "users_department_fk" }),
    foreignKey({ columns: [t.tenantId, t.entityId], foreignColumns: [legalEntities.tenantId, legalEntities.id], name: "users_entity_fk" }),
  ],
);

export const requests = pgTable(
  "requests",
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    taxYear: integer("tax_year").notNull(),
    dueDate: date("due_date", { mode: "string" }).notNull(),
    priority: priorityEnum("priority").notNull().default("medium"),
    status: requestStatusEnum("status").notNull().default("draft"),
    createdBy: uuid("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    unique("requests_tenant_id_id").on(t.tenantId, t.id),
    unique("requests_tenant_reference").on(t.tenantId, t.reference),
    foreignKey({ columns: [t.tenantId, t.createdBy], foreignColumns: [users.tenantId, users.id], name: "requests_created_by_fk" }),
    index("requests_tenant_status_due").on(t.tenantId, t.status, t.dueDate),
  ],
);

export const requestItems = pgTable(
  "request_items",
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    requestId: uuid("request_id").notNull(),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    dataType: dataTypeEnum("data_type").notNull(),
    required: boolean("required").notNull().default(true),
    status: itemStatusEnum("status").notNull().default("pending"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("request_items_tenant_id_id").on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.requestId], foreignColumns: [requests.tenantId, requests.id], name: "request_items_request_fk" }),
    index("request_items_request").on(t.tenantId, t.requestId),
  ],
);

export const assignments = pgTable(
  "assignments",
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    requestId: uuid("request_id").notNull(),
    assigneeType: assigneeTypeEnum("assignee_type").notNull(),
    departmentId: uuid("department_id"),
    entityId: uuid("entity_id"),
    userId: uuid("user_id"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.tenantId, t.requestId], foreignColumns: [requests.tenantId, requests.id], name: "assignments_request_fk" }),
    foreignKey({ columns: [t.tenantId, t.departmentId], foreignColumns: [departments.tenantId, departments.id], name: "assignments_department_fk" }),
    foreignKey({ columns: [t.tenantId, t.entityId], foreignColumns: [legalEntities.tenantId, legalEntities.id], name: "assignments_entity_fk" }),
    foreignKey({ columns: [t.tenantId, t.userId], foreignColumns: [users.tenantId, users.id], name: "assignments_user_fk" }),
    // Exactly one target column is set, and it matches assignee_type.
    check(
      "assignments_one_target",
      sql`(${t.assigneeType} = 'department' AND ${t.departmentId} IS NOT NULL AND ${t.entityId} IS NULL AND ${t.userId} IS NULL)
        OR (${t.assigneeType} = 'entity' AND ${t.entityId} IS NOT NULL AND ${t.departmentId} IS NULL AND ${t.userId} IS NULL)
        OR (${t.assigneeType} = 'user' AND ${t.userId} IS NOT NULL AND ${t.departmentId} IS NULL AND ${t.entityId} IS NULL)`,
    ),
    index("assignments_request").on(t.tenantId, t.requestId),
  ],
);

/** A contributor's response to an item. Versioned; Phase 2 attaches files to a submission. */
export const submissions = pgTable(
  "submissions",
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    itemId: uuid("item_id").notNull(),
    version: integer("version").notNull(),
    submittedBy: uuid("submitted_by").notNull(),
    note: text("note").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("submissions_tenant_id_id").on(t.tenantId, t.id),
    unique("submissions_item_version").on(t.itemId, t.version),
    foreignKey({ columns: [t.tenantId, t.itemId], foreignColumns: [requestItems.tenantId, requestItems.id], name: "submissions_item_fk" }),
    foreignKey({ columns: [t.tenantId, t.submittedBy], foreignColumns: [users.tenantId, users.id], name: "submissions_user_fk" }),
  ],
);

export const reviews = pgTable(
  "reviews",
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    submissionId: uuid("submission_id").notNull(),
    reviewerId: uuid("reviewer_id").notNull(),
    decision: reviewDecisionEnum("decision").notNull(),
    rationale: text("rationale").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.tenantId, t.submissionId], foreignColumns: [submissions.tenantId, submissions.id], name: "reviews_submission_fk" }),
    foreignKey({ columns: [t.tenantId, t.reviewerId], foreignColumns: [users.tenantId, users.id], name: "reviews_reviewer_fk" }),
    unique("reviews_one_per_submission").on(t.submissionId),
  ],
);

export const comments = pgTable(
  "comments",
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    requestId: uuid("request_id").notNull(),
    itemId: uuid("item_id"),
    authorId: uuid("author_id").notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.tenantId, t.requestId], foreignColumns: [requests.tenantId, requests.id], name: "comments_request_fk" }),
    foreignKey({ columns: [t.tenantId, t.itemId], foreignColumns: [requestItems.tenantId, requestItems.id], name: "comments_item_fk" }),
    foreignKey({ columns: [t.tenantId, t.authorId], foreignColumns: [users.tenantId, users.id], name: "comments_author_fk" }),
    index("comments_request").on(t.tenantId, t.requestId, t.createdAt),
  ],
);

/**
 * Append-only, hash-chained audit trail. `seq`, `occurred_at`, `prev_hash` and `hash` are
 * assigned by a database trigger, so application code cannot forge or skip them. The app role
 * has INSERT and SELECT only; UPDATE/DELETE/TRUNCATE are also blocked by triggers.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    tenantId: tenantId().references(() => tenants.id),
    seq: bigint("seq", { mode: "number" }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: uuid("actor_id"),
    actorLabel: text("actor_label").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    requestRef: uuid("request_ref"),
    summary: text("summary").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [
    unique("audit_events_tenant_seq").on(t.tenantId, t.seq),
    index("audit_events_entity").on(t.tenantId, t.entityType, t.entityId),
    index("audit_events_request").on(t.tenantId, t.requestRef, t.seq),
  ],
);

/**
 * An uploaded file, attached to a submission. Only files that passed validation AND malware scanning are
 * ever stored, so every row here is clean by construction; `scanner` records which engine said so.
 * Bytes live in object storage under `<tenant>/<file id>`; the user-supplied name is display-only.
 */
export const files = pgTable(
  "files",
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    submissionId: uuid("submission_id").notNull(),
    originalName: text("original_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    storageKey: text("storage_key").notNull(),
    scanner: text("scanner").notNull(),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull(),
    uploadedBy: uuid("uploaded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("files_tenant_id_id").on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.submissionId], foreignColumns: [submissions.tenantId, submissions.id], name: "files_submission_fk" }),
    foreignKey({ columns: [t.tenantId, t.uploadedBy], foreignColumns: [users.tenantId, users.id], name: "files_uploader_fk" }),
    index("files_submission").on(t.tenantId, t.submissionId),
    check("files_size_positive", sql`${t.sizeBytes} > 0`),
  ],
);

/**
 * Language-neutral work queue. The web app enqueues inside the same transaction as the change that
 * caused the work; the Python worker claims jobs through SECURITY DEFINER functions (never direct table access).
 */
export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    status: jobStatusEnum("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("jobs_claim").on(t.status, t.runAfter), index("jobs_tenant").on(t.tenantId, t.createdAt)],
);
