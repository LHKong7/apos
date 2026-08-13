ALTER TABLE "agent_runs" ALTER COLUMN "work_item_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "kind" text DEFAULT 'execution' NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_runs_kind_idx" ON "agent_runs" USING btree ("kind","project_id","created_at");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_kind_check" CHECK ("agent_runs"."kind" in ('execution', 'planning'));--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_shape_check" CHECK (("agent_runs"."kind" = 'execution' and "agent_runs"."work_item_id" is not null)
          or ("agent_runs"."kind" = 'planning' and "agent_runs"."work_item_id" is null));