ALTER TABLE "repositories" ADD COLUMN "check_command" text;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "check_timeout_seconds" integer DEFAULT 900 NOT NULL;