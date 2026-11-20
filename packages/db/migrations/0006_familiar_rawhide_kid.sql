CREATE TABLE "rule_settings" (
	"tenant_id" uuid NOT NULL,
	"rule_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rule_settings_pk" UNIQUE("tenant_id","rule_id")
);
--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "source_proposal_id" uuid;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "rule_id" text;--> statement-breakpoint
ALTER TABLE "rule_settings" ADD CONSTRAINT "rule_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_settings" ADD CONSTRAINT "rule_settings_user_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_source_fk" FOREIGN KEY ("tenant_id","source_proposal_id") REFERENCES "public"."proposals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposals_source" ON "proposals" USING btree ("tenant_id","source_proposal_id");