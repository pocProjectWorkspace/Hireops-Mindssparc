CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"primary_region" text NOT NULL,
	"status" text NOT NULL,
	"tier" text DEFAULT 'standard' NOT NULL,
	"onboarding_status" text DEFAULT 'in_progress' NOT NULL,
	"onboarding_step_completed" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"scheduled_deletion_at" timestamp with time zone,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "tenant_encryption_keys" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"encrypted_dek" "bytea" NOT NULL,
	"kms_key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"rotation_status" text
);
--> statement-breakpoint
ALTER TABLE "tenant_encryption_keys" ADD CONSTRAINT "tenant_encryption_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tenants_status" ON "tenants" USING btree ("status");