ALTER TABLE "agent_runs" ADD COLUMN "recovery_action" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "recovery_reason" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "recovery_not_before" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "recovery_applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "recovery_agent_id" uuid;