DROP INDEX "project_agent_bindings_project_role_idx";--> statement-breakpoint
ALTER TABLE "project_agent_bindings" ADD COLUMN "priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "project_agent_bindings_project_role_agent_idx" ON "project_agent_bindings" USING btree ("project_id","role","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_agent_bindings_project_role_idx" ON "project_agent_bindings" USING btree ("project_id","role","priority");