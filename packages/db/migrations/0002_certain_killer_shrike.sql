CREATE TABLE "dev_external_objects" (
	"provider" text NOT NULL,
	"external_key" text NOT NULL,
	"url" text,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_change" jsonb,
	"deleted" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dev_external_objects_provider_external_key_pk" PRIMARY KEY("provider","external_key")
);
