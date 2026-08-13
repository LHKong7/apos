ALTER TABLE "repositories" ADD COLUMN "delivery_target_id" uuid;--> statement-breakpoint
ALTER TABLE "storage_targets" ADD COLUMN "delivery_target_id" uuid;