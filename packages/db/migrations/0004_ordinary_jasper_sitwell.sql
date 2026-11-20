CREATE TYPE "public"."proposal_kind" AS ENUM('extraction', 'finding');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('pending', 'accepted', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('succeeded', 'skipped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('info', 'warning', 'error');--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"agent_name" text NOT NULL,
	"agent_version" text NOT NULL,
	"event" text NOT NULL,
	"file_id" uuid,
	"status" "run_status" NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"model" text,
	"prompt_version" text,
	"llm_calls" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runs_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "agent_runs_job_agent" UNIQUE("job_id","agent_name")
);
--> statement-breakpoint
CREATE TABLE "extracted_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"sheet" text NOT NULL,
	"source_row" integer NOT NULL,
	"values" jsonb NOT NULL,
	"cells" jsonb NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"kind" "proposal_kind" NOT NULL,
	"schema_key" text,
	"title" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"payload" jsonb NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"severity" "severity",
	"status" "proposal_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposals_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "proposals_confidence_range" CHECK ("proposals"."confidence" >= 0 AND "proposals"."confidence" <= 1)
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "ai_extraction_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "external_llm_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_file_fk" FOREIGN KEY ("tenant_id","file_id") REFERENCES "public"."files"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_rows" ADD CONSTRAINT "extracted_rows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_rows" ADD CONSTRAINT "extracted_rows_proposal_fk" FOREIGN KEY ("tenant_id","proposal_id") REFERENCES "public"."proposals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."agent_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_file_fk" FOREIGN KEY ("tenant_id","file_id") REFERENCES "public"."files"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."requests"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_item_fk" FOREIGN KEY ("tenant_id","item_id") REFERENCES "public"."request_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_decider_fk" FOREIGN KEY ("tenant_id","decided_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_file" ON "agent_runs" USING btree ("tenant_id","file_id");--> statement-breakpoint
CREATE INDEX "extracted_rows_proposal" ON "extracted_rows" USING btree ("tenant_id","proposal_id","position");--> statement-breakpoint
CREATE INDEX "proposals_queue" ON "proposals" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "proposals_file" ON "proposals" USING btree ("tenant_id","file_id");--> statement-breakpoint
CREATE INDEX "proposals_request" ON "proposals" USING btree ("tenant_id","request_id");