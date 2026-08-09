CREATE TABLE "idempotency_keys" (
	"key" text NOT NULL,
	"endpoint" text NOT NULL,
	"status_code" integer NOT NULL,
	"response" jsonb NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_key_endpoint_pk" PRIMARY KEY("key","endpoint")
);
--> statement-breakpoint
ALTER TABLE "integrations" ALTER COLUMN "scopes" SET DEFAULT '{"allowed":[],"denied":[],"probed":true}'::jsonb;--> statement-breakpoint
CREATE INDEX "idempotency_created_idx" ON "idempotency_keys" USING btree ("created_at");