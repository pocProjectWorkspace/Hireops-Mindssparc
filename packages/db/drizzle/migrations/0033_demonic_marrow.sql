-- NOTE: drizzle-kit re-detected the hand-written FK relaxations from
-- 0031 + the partial-unique change from 0032 as schema drift (because
-- the prior snapshot still had the old compound FKs / full unique).
-- The DROP CONSTRAINT / DROP INDEX / re-ADD blocks were removed; they're
-- already in place from 0031 + 0032. Re-running them here would fail
-- with 42704 (constraint doesn't exist).
--
-- Only the Module 4 net-new bits remain.

CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"drafted_by_membership_id" uuid NOT NULL,
	"base_salary_inr_paise" bigint NOT NULL,
	"variable_target_inr_paise" bigint,
	"joining_bonus_inr_paise" bigint,
	"joining_date" date NOT NULL,
	"location" text NOT NULL,
	"expiry_at" timestamp with time zone NOT NULL,
	"terms_html" text,
	"status" text DEFAULT 'drafted' NOT NULL,
	"extended_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"declined_reason" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_reason" text,
	"accept_signed_link_token_hash" text,
	"accepted_from_ip" "inet",
	"accepted_user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_offers_tenant_id_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "offers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workday_sync_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"business_key" text NOT NULL,
	"subject_application_id" uuid,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"simulated_response" jsonb,
	"simulated_at" timestamp with time zone,
	"provider_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_workday_sync_outbox_tenant_id_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "workday_sync_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "fk_offers_application" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "fk_offers_drafted_by" FOREIGN KEY ("tenant_id","drafted_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workday_sync_outbox" ADD CONSTRAINT "workday_sync_outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workday_sync_outbox" ADD CONSTRAINT "fk_workday_sync_outbox_application" FOREIGN KEY ("tenant_id","subject_application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_offers_application_extended" ON "offers" USING btree ("tenant_id","application_id") WHERE status = 'extended';--> statement-breakpoint
CREATE INDEX "idx_offers_application_history" ON "offers" USING btree ("tenant_id","application_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_offers_extended_expiry" ON "offers" USING btree ("tenant_id","expiry_at") WHERE status = 'extended';--> statement-breakpoint
CREATE INDEX "idx_offers_accept_token_hash" ON "offers" USING btree ("accept_signed_link_token_hash") WHERE accept_signed_link_token_hash IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_workday_sync_outbox_business_key" ON "workday_sync_outbox" USING btree ("tenant_id","business_key");--> statement-breakpoint
CREATE INDEX "idx_workday_sync_outbox_queue" ON "workday_sync_outbox" USING btree ("tenant_id","status","created_at") WHERE status IN ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "idx_workday_sync_outbox_type_chrono" ON "workday_sync_outbox" USING btree ("tenant_id","event_type","created_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "offers" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "workday_sync_outbox" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
