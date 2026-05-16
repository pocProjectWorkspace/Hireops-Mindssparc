CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"recipient_type" text NOT NULL,
	"recipient_email" text NOT NULL,
	"recipient_membership_id" uuid,
	"recipient_candidate_id" uuid,
	"template_key" text NOT NULL,
	"template_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedup_key" text,
	"subject" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" smallint DEFAULT 5 NOT NULL,
	"scheduled_for" timestamp with time zone,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"sent_at" timestamp with time zone,
	"provider_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_notification_outbox_tenant_id_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "notification_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "dev_email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"recipient_email" text NOT NULL,
	"subject" text NOT NULL,
	"rendered_html" text NOT NULL,
	"rendered_text" text NOT NULL,
	"template_key" text NOT NULL,
	"outbox_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_dev_email_outbox_tenant_id_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "dev_email_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "signed_link_uses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"action" text NOT NULL,
	"subject_id" uuid,
	"redeemed_by_ip" "inet",
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"successful" boolean NOT NULL,
	"failure_reason" text,
	CONSTRAINT "uniq_signed_link_uses_tenant_id_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "signed_link_uses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "scheduled_job_runs" (
	"job_name" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone NOT NULL,
	"last_run_duration_ms" integer,
	"last_run_status" text NOT NULL,
	"last_run_error" text
);
--> statement-breakpoint
ALTER TABLE "scheduled_job_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "fk_notification_outbox_membership" FOREIGN KEY ("tenant_id","recipient_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "fk_notification_outbox_candidate" FOREIGN KEY ("tenant_id","recipient_candidate_id") REFERENCES "public"."candidates"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dev_email_outbox" ADD CONSTRAINT "dev_email_outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dev_email_outbox" ADD CONSTRAINT "fk_dev_email_outbox_outbox" FOREIGN KEY ("tenant_id","outbox_id") REFERENCES "public"."notification_outbox"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signed_link_uses" ADD CONSTRAINT "signed_link_uses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_notification_outbox_queue" ON "notification_outbox" USING btree ("tenant_id","status","priority","created_at") WHERE status IN ('pending', 'processing');--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_notification_outbox_dedup" ON "notification_outbox" USING btree ("tenant_id","dedup_key") WHERE dedup_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_notification_outbox_recipient_chrono" ON "notification_outbox" USING btree ("tenant_id","recipient_email","sent_at");--> statement-breakpoint
CREATE INDEX "idx_notification_outbox_orphan_sweep" ON "notification_outbox" USING btree ("claimed_at") WHERE status = 'processing';--> statement-breakpoint
CREATE INDEX "idx_dev_email_outbox_tenant_chrono" ON "dev_email_outbox" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_signed_link_uses_tenant_token" ON "signed_link_uses" USING btree ("tenant_id","token_hash");--> statement-breakpoint
CREATE INDEX "idx_signed_link_uses_tenant_chrono" ON "signed_link_uses" USING btree ("tenant_id","redeemed_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notification_outbox" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "dev_email_outbox" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation_select" ON "signed_link_uses" AS PERMISSIVE FOR SELECT TO "authenticated" USING (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "signed_link_uses" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "scheduled_job_runs_auth_admin_read" ON "scheduled_job_runs" AS PERMISSIVE FOR SELECT TO "supabase_auth_admin" USING (true);