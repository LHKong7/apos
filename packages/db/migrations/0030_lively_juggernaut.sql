CREATE TABLE "project_agent_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"member_actor_type" "actor_type" DEFAULT 'agent' NOT NULL,
	"profile_key" text NOT NULL,
	"profile_version" integer NOT NULL,
	"allowed_capabilities" text[] DEFAULT '{}' NOT NULL,
	"denied_capabilities" text[] DEFAULT '{}' NOT NULL,
	"resource_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_agent_permissions_actor_type_check" CHECK ("project_agent_permissions"."member_actor_type" = 'agent')
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "capability_ceiling" text[];--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "denied_capabilities" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_agent_permissions" ADD CONSTRAINT "project_agent_permissions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_agent_permissions" ADD CONSTRAINT "project_agent_permissions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_agent_permissions" ADD CONSTRAINT "project_agent_permissions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_agent_permissions" ADD CONSTRAINT "project_agent_permissions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_agent_permissions" ADD CONSTRAINT "project_agent_permissions_member_fk" FOREIGN KEY ("project_id","member_actor_type","agent_id") REFERENCES "public"."project_members"("project_id","actor_type","actor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_agent_permissions_project_agent_idx" ON "project_agent_permissions" USING btree ("project_id","agent_id");--> statement-breakpoint
CREATE INDEX "project_agent_permissions_agent_idx" ON "project_agent_permissions" USING btree ("agent_id");