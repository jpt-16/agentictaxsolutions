CREATE TABLE "proposal_entities" (
	"proposal_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"source" text NOT NULL,
	"set_by" uuid NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposal_entities_source" CHECK ("proposal_entities"."source" IN ('assignment', 'uploader', 'file', 'reviewer'))
);
--> statement-breakpoint
ALTER TABLE "proposal_entities" ADD CONSTRAINT "proposal_entities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_entities" ADD CONSTRAINT "proposal_entities_proposal_fk" FOREIGN KEY ("tenant_id","proposal_id") REFERENCES "public"."proposals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_entities" ADD CONSTRAINT "proposal_entities_entity_fk" FOREIGN KEY ("tenant_id","entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_entities" ADD CONSTRAINT "proposal_entities_user_fk" FOREIGN KEY ("tenant_id","set_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;