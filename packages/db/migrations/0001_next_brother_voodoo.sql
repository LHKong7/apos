CREATE TABLE "integration_object_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"external_key" text NOT NULL,
	"external_url" text,
	"last_synced_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_synced_at" timestamp with time zone,
	"external_deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_links_item_uq" UNIQUE("integration_id","work_item_id"),
	CONSTRAINT "integration_links_external_uq" UNIQUE("integration_id","external_key")
);
--> statement-breakpoint
CREATE TABLE "integration_sync_mappings" (
	"integration_id" uuid NOT NULL,
	"field" text NOT NULL,
	"source_of_truth" text NOT NULL,
	"strategy" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_sync_mappings_integration_id_field_pk" PRIMARY KEY("integration_id","field")
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"category" text NOT NULL,
	"display_name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credential_ref" text,
	"credential_hint" text,
	"credential_expires_at" timestamp with time zone,
	"scopes" jsonb DEFAULT '{"allowed":[],"denied":[]}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"last_sync_at" timestamp with time zone,
	"notification_config" jsonb,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integrations_project_provider_uq" UNIQUE("project_id","provider")
);
--> statement-breakpoint
CREATE TABLE "sync_conflict_rules" (
	"integration_id" uuid NOT NULL,
	"field" text NOT NULL,
	"winner" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_conflict_rules_integration_id_field_pk" PRIMARY KEY("integration_id","field")
);
--> statement-breakpoint
CREATE TABLE "sync_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"field" text NOT NULL,
	"apos_side" jsonb NOT NULL,
	"external_side" jsonb NOT NULL,
	"source_of_truth" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"resolved_winner" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"auto_resolved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_object_links" ADD CONSTRAINT "integration_object_links_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_object_links" ADD CONSTRAINT "integration_object_links_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_sync_mappings" ADD CONSTRAINT "integration_sync_mappings_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_sync_mappings" ADD CONSTRAINT "integration_sync_mappings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_conflict_rules" ADD CONSTRAINT "sync_conflict_rules_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_conflict_rules" ADD CONSTRAINT "sync_conflict_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_conflicts" ADD CONSTRAINT "sync_conflicts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_conflicts" ADD CONSTRAINT "sync_conflicts_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_conflicts" ADD CONSTRAINT "sync_conflicts_link_id_integration_object_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."integration_object_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_conflicts" ADD CONSTRAINT "sync_conflicts_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integration_links_item_idx" ON "integration_object_links" USING btree ("work_item_id");--> statement-breakpoint
CREATE INDEX "integrations_project_idx" ON "integrations" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "sync_conflicts_project_idx" ON "sync_conflicts" USING btree ("project_id","status","created_at");