-- =====================================================================
-- 0086_recr_03_recruiter_brief.sql — RECR-03 (hand-written)
--
-- The cached, REAL-AI recruiter-brief aids for an application. Sibling of
-- interview_prep (0074) and requisition_feasibility (0062): AI output only,
-- cached ONE row per (application, kind), regenerate REPLACES (ON CONFLICT
-- upsert). Tenant-scoped derived data. `kind` is one of strengths_risks |
-- screen_script | availability_draft (the last is a DRAFT only — caching it
-- never sends it).
--
-- Hand-written (the drizzle snapshot chain is behind the schema — known debt).
-- Force-RLS + audit-trigger companions land in 0087.
-- =====================================================================

CREATE TABLE "recruiter_brief" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"content" jsonb NOT NULL,
	"model" text,
	"prompt_version" text,
	"generated_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_recruiter_brief_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_recruiter_brief_per_app_kind" UNIQUE("tenant_id","application_id","kind")
);
--> statement-breakpoint
ALTER TABLE "recruiter_brief" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recruiter_brief" ADD CONSTRAINT "recruiter_brief_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recruiter_brief" ADD CONSTRAINT "fk_recruiter_brief_application" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recruiter_brief" ADD CONSTRAINT "fk_recruiter_brief_generated_by" FOREIGN KEY ("tenant_id","generated_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_recruiter_brief_app" ON "recruiter_brief" USING btree ("tenant_id","application_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "recruiter_brief" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
