-- =====================================================================
-- 0135_tenant_provisioning.sql — C1-F11 (hand-written)
--
-- tenant_provisioning_jobs — one row per tenant created through the platform
-- console (Plan A §14.3). Provisioning is an idempotent, resumable job over a
-- fixed list of steps (tenant row → encryption key → module entitlements →
-- starter pack → admin invite → admin membership → activate); `steps` records
-- which have completed, so a failed run resumes at the first step not done
-- and a re-run never duplicates anything.
--
-- PLATFORM table: operators have no tenant, so there is no tenant read path.
-- RLS enabled + FORCED with NO policies (service-role pool only), the
-- platform_operators / platform_audit_log posture; allowlisted in
-- lint-rls.ts. `request` keeps what a retry needs (pack, tier, module
-- overrides, the first admin's email) — never a secret. Tenants made by seed
-- scripts before this migration simply have no row.
--
-- No backfill, no change to existing tables.
-- =====================================================================

CREATE TABLE "tenant_provisioning_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"starter_pack_key" text NOT NULL,
	"starter_pack_version" integer NOT NULL,
	"request" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"steps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_by_operator" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "uniq_tenant_provisioning_jobs_tenant" UNIQUE ("tenant_id"),
	CONSTRAINT "tenant_provisioning_jobs_status_check" CHECK ("status" IN ('pending', 'running', 'failed', 'completed')),
	CONSTRAINT "tenant_provisioning_jobs_pack_key_check" CHECK ("starter_pack_key" ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
	CONSTRAINT "tenant_provisioning_jobs_pack_version_check" CHECK ("starter_pack_version" >= 1),
	CONSTRAINT "tenant_provisioning_jobs_request_check" CHECK (jsonb_typeof("request") = 'object'),
	CONSTRAINT "tenant_provisioning_jobs_steps_check" CHECK (jsonb_typeof("steps") = 'object'),
	CONSTRAINT "tenant_provisioning_jobs_last_error_check" CHECK ("last_error" IS NULL OR char_length("last_error") <= 2000)
);--> statement-breakpoint
ALTER TABLE "tenant_provisioning_jobs" ADD CONSTRAINT "tenant_provisioning_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_provisioning_jobs" ADD CONSTRAINT "tenant_provisioning_jobs_created_by_operator_fkey" FOREIGN KEY ("created_by_operator") REFERENCES "public"."platform_operators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tenant_provisioning_jobs_status" ON "tenant_provisioning_jobs" USING btree ("status", "updated_at");--> statement-breakpoint
ALTER TABLE "tenant_provisioning_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.tenant_provisioning_jobs FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.tenant_provisioning_jobs FROM anon, authenticated;
