CREATE TABLE "request_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"items" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "request_templates_name_len" CHECK (char_length("request_templates"."name") between 3 and 120),
	CONSTRAINT "request_templates_items_array" CHECK (jsonb_typeof("request_templates"."items") = 'array' AND jsonb_array_length("request_templates"."items") between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "request_templates" ADD CONSTRAINT "request_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_templates" ADD CONSTRAINT "request_templates_user_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "request_templates_list" ON "request_templates" USING btree ("tenant_id","archived_at","name");