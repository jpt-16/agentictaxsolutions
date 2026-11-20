import {
  bigint, boolean, check, numeric, date, foreignKey, index, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid,
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
export const runStatusEnum = pgEnum("run_status", ["succeeded", "skipped", "failed"]);
export const proposalKindEnum = pgEnum("proposal_kind", ["extraction", "finding"]);
export const proposalStatusEnum = pgEnum("proposal_status", ["pending", "accepted", "rejected", "superseded"]);
export const severityEnum = pgEnum("severity", ["info", "warning", "error"]);
export const actorTypeEnum = pgEnum("actor_type", ["user", "agent", "system"]);

const id = () => uuid("id").primaryKey().defaultRandom();
const tenantId = () => uuid("tenant_id").notNull();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const tenants = pgTable("tenants", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  // Data-governance switches. Both default OFF: a tenant must opt in before any AI processing happens,
  // and separately before any content may leave our boundary to an external model provider.
  aiExtractionEnabled: boolean("ai_extraction_enabled").notNull().default(false),
  externalLlmEnabled: boolean("external_llm_enabled").notNull().default(false),
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

/** One execution of an agent for one job: provenance for every proposal it produced. Written only by the worker's functions. */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    jobId: uuid("job_id").notNull().references(() => jobs.id),
    agentName: text("agent_name").notNull(),
    agentVersion: text("agent_version").notNull(),
    event: text("event").notNull(),
    fileId: uuid("file_id"),
    status: runStatusEnum("status").notNull(),
    detail: text("detail").notNull().default(""),
    model: text("model"),
    promptVersion: text("prompt_version"),
    llmCalls: integer("llm_calls").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    unique("agent_runs_tenant_id_id").on(t.tenantId, t.id),
    // A retried job must not produce a second set of results.
    unique("agent_runs_job_agent").on(t.jobId, t.agentName),
    foreignKey({ columns: [t.tenantId, t.fileId], foreignColumns: [files.tenantId, files.id], name: "agent_runs_file_fk" }),
    index("agent_runs_file").on(t.tenantId, t.fileId),
  ],
);

/**
 * Something an AI agent suggests. It NEVER changes business data by itself: a human accepts or rejects it,
 * and that decision is final (enforced by a trigger). Only the worker's SECURITY DEFINER function can insert.
 */
export const proposals = pgTable(
  "proposals",
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    runId: uuid("run_id").notNull(),
    fileId: uuid("file_id").notNull(),
    requestId: uuid("request_id").notNull(),
    itemId: uuid("item_id").notNull(),
    kind: proposalKindEnum("kind").notNull(),
    schemaKey: text("schema_key"),
    // Findings point at the accepted extraction they were raised against, and at the rule that raised them.
    sourceProposalId: uuid("source_proposal_id"),
    ruleId: text("rule_id"),
    title: text("title").notNull(),
    detail: text("detail").notNull().default(""),
    payload: jsonb("payload").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    severity: severityEnum("severity"),
    status: proposalStatusEnum("status").notNull().default("pending"),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("proposals_tenant_id_id").on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.runId], foreignColumns: [agentRuns.tenantId, agentRuns.id], name: "proposals_run_fk" }),
    foreignKey({ columns: [t.tenantId, t.fileId], foreignColumns: [files.tenantId, files.id], name: "proposals_file_fk" }),
    foreignKey({ columns: [t.tenantId, t.requestId], foreignColumns: [requests.tenantId, requests.id], name: "proposals_request_fk" }),
    foreignKey({ columns: [t.tenantId, t.itemId], foreignColumns: [requestItems.tenantId, requestItems.id], name: "proposals_item_fk" }),
    foreignKey({ columns: [t.tenantId, t.decidedBy], foreignColumns: [users.tenantId, users.id], name: "proposals_decider_fk" }),
    foreignKey({ columns: [t.tenantId, t.sourceProposalId], foreignColumns: [t.tenantId, t.id], name: "proposals_source_fk" }),
    index("proposals_source").on(t.tenantId, t.sourceProposalId),
    check("proposals_confidence_range", sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`),
    index("proposals_queue").on(t.tenantId, t.status, t.createdAt),
    index("proposals_file").on(t.tenantId, t.fileId),
    index("proposals_request").on(t.tenantId, t.requestId),
  ],
);

/** Standardized rows an extraction proposal would produce, each traceable to its source cell. */
export const extractedRows = pgTable(
  "extracted_rows",
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    proposalId: uuid("proposal_id").notNull(),
    position: integer("position").notNull(),
    sheet: text("sheet").notNull(),
    sourceRow: integer("source_row").notNull(),
    values: jsonb("values").notNull(),
    cells: jsonb("cells").notNull(),
    issues: jsonb("issues").notNull().default(sql`'[]'::jsonb`),
  },
  (t) => [
    foreignKey({ columns: [t.tenantId, t.proposalId], foreignColumns: [proposals.tenantId, proposals.id], name: "extracted_rows_proposal_fk" }),
    index("extracted_rows_proposal").on(t.tenantId, t.proposalId, t.position),
  ],
);

/** Per-tenant switches and parameters for validation rules. Writable only by tax managers and tenant admins (trigger-enforced). */
export const ruleSettings = pgTable(
  "rule_settings",
  {
    tenantId: tenantId().references(() => tenants.id),
    ruleId: text("rule_id").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    params: jsonb("params").notNull().default(sql`'{}'::jsonb`),
    updatedBy: uuid("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("rule_settings_pk").on(t.tenantId, t.ruleId),
    foreignKey({ columns: [t.tenantId, t.updatedBy], foreignColumns: [users.tenantId, users.id], name: "rule_settings_user_fk" }),
  ],
);

/**
 * In-app notifications. A user can only ever read or mark-read THEIR OWN (row policy on app.user_id); anyone in the tenant
 * can create them (fan-out happens inside the workflow transaction). `dedupe_key` makes sweeps and retries idempotent.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    userId: uuid("user_id").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    link: text("link"),
    dedupeKey: text("dedupe_key"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.tenantId, t.userId], foreignColumns: [users.tenantId, users.id], name: "notifications_user_fk" }),
    unique("notifications_dedupe").on(t.tenantId, t.userId, t.dedupeKey),
    index("notifications_inbox").on(t.tenantId, t.userId, t.readAt, t.createdAt),
  ],
);
