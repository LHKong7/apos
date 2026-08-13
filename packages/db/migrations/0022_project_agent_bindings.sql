CREATE TABLE "project_agent_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"role" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_agent_bindings_role_check" CHECK ("project_agent_bindings"."role" in ('planner', 'coordinator', 'reviewer'))
);
--> statement-breakpoint
ALTER TABLE "project_agent_bindings" ADD CONSTRAINT "project_agent_bindings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_agent_bindings" ADD CONSTRAINT "project_agent_bindings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_agent_bindings" ADD CONSTRAINT "project_agent_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_agent_bindings" ADD CONSTRAINT "project_agent_bindings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_agent_bindings_project_role_idx" ON "project_agent_bindings" USING btree ("project_id","role");--> statement-breakpoint
CREATE INDEX "project_agent_bindings_agent_idx" ON "project_agent_bindings" USING btree ("agent_id");
--> statement-breakpoint
-- ★ 新表要跟上 0017 那条纪律：public 下的表默认对 anon / authenticated 全关。
--   不补的话，托管平台（Supabase）会给它自动生成一套匿名 REST 接口，
--   而启动时的 auditRls 只会「喊出来」，不会替你关上。
--   属主仍然天然绕过 RLS，后端读写不受影响。
ALTER TABLE "project_agent_bindings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "project_agent_bindings" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "project_agent_bindings" FROM authenticated;
  END IF;
END $$;
