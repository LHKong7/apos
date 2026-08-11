CREATE TABLE "storage_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"ref" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"endpoint" text,
	"region" text DEFAULT 'us-east-1' NOT NULL,
	"bucket" text,
	"prefix" text DEFAULT '' NOT NULL,
	"force_path_style" boolean DEFAULT true NOT NULL,
	"root_path" text,
	"credential_ref" text,
	"credential_hint" text,
	"writable" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_targets_kind_check" CHECK ("storage_targets"."kind" in ('object_storage', 'local')),
	CONSTRAINT "storage_targets_shape_check" CHECK (("storage_targets"."kind" = 'object_storage' and "storage_targets"."endpoint" is not null and "storage_targets"."bucket" is not null)
          or ("storage_targets"."kind" = 'local' and "storage_targets"."root_path" is not null))
);
--> statement-breakpoint
ALTER TABLE "storage_targets" ADD CONSTRAINT "storage_targets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_targets" ADD CONSTRAINT "storage_targets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_targets" ADD CONSTRAINT "storage_targets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "storage_targets_org_ref_idx" ON "storage_targets" USING btree ("org_id","ref");