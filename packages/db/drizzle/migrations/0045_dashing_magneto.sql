-- =====================================================================
-- 0045_dashing_magneto.sql — ONBOARD-01 onboarding pillar (schema)
--
-- Drizzle-generated CREATE TABLE / FK / INDEX / POLICY for the onboarding
-- table group (document_types, onboarding_cases, onboarding_tasks,
-- onboarding_documents, bgv_runs, bgv_results, it_provisioning_requests,
-- asset_assignments).
--
-- HAND-TRIMMED per HANDOVER reality #83: drizzle-kit diffs against the
-- latest snapshot (0040), which predates the hand-written 0043
-- (pii_access_log). The generator therefore re-emitted CREATE TABLE /
-- FK / INDEX / POLICY for pii_access_log — all removed here so this
-- migration is purely additive against the live dev DB. The 0045
-- snapshot retains the full schema (pii_access_log included) so it is a
-- correct baseline for the next generate. FORCE RLS + audit triggers +
-- the document_types seed are the hand-written companions 0046/0047/0048.
-- =====================================================================

CREATE TABLE "document_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"geography_code" char(2),
	"required_for_lifecycle_stage" text,
	"retention_years" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_document_types_code" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "document_types" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "onboarding_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"status" text DEFAULT 'pre_boarding' NOT NULL,
	"geography_code" char(2) NOT NULL,
	"expected_start_date" date,
	"actual_start_date" date,
	"probation_days" integer DEFAULT 90 NOT NULL,
	"probation_ends_at" date,
	"buddy_membership_id" uuid,
	"manager_membership_id" uuid,
	"workday_worker_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_onboarding_cases_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "onboarding_cases_status_check" CHECK ("onboarding_cases"."status" IN ('pre_boarding', 'day_zero', 'in_progress', 'completed', 'cancelled')),
	CONSTRAINT "onboarding_cases_probation_days_check" CHECK ("onboarding_cases"."probation_days" BETWEEN 1 AND 180)
);
--> statement-breakpoint
ALTER TABLE "onboarding_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "onboarding_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"task_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"assignee_membership_id" uuid,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"blocked_reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_onboarding_tasks_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "onboarding_tasks_task_type_check" CHECK ("onboarding_tasks"."task_type" IN ('document_collection', 'bgv', 'it_provisioning', 'asset_assignment', 'training', 'orientation', 'buddy_assignment', 'probation_review', 'check_in', 'medical', 'payroll_form', 'equipment_preference', 'other')),
	CONSTRAINT "onboarding_tasks_status_check" CHECK ("onboarding_tasks"."status" IN ('pending', 'in_progress', 'blocked', 'completed', 'cancelled', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "onboarding_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "onboarding_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"document_type_id" uuid NOT NULL,
	"storage_ref" text NOT NULL,
	"file_name" text,
	"mime_type" text,
	"size_bytes" bigint,
	"encryption_key_ref" text,
	"verification_status" text DEFAULT 'pending' NOT NULL,
	"verified_by_membership_id" uuid,
	"verified_at" timestamp with time zone,
	"rejection_reason" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_onboarding_documents_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "onboarding_documents_verification_status_check" CHECK ("onboarding_documents"."verification_status" IN ('pending', 'verified', 'rejected', 'resubmit_required'))
);
--> statement-breakpoint
ALTER TABLE "onboarding_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "bgv_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"vendor" text NOT NULL,
	"vendor_reference" text,
	"status" text DEFAULT 'initiated' NOT NULL,
	"packages" jsonb,
	"initiated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"webhook_last_received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_bgv_runs_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "bgv_runs_status_check" CHECK ("bgv_runs"."status" IN ('initiated', 'in_progress', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "bgv_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "bgv_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bgv_run_id" uuid NOT NULL,
	"check_type" text NOT NULL,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"details" jsonb,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_bgv_results_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "bgv_results_outcome_check" CHECK ("bgv_results"."outcome" IN ('clear', 'discrepancy', 'flagged', 'unable_to_verify', 'pending'))
);
--> statement-breakpoint
ALTER TABLE "bgv_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "it_provisioning_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"resource_type" text NOT NULL,
	"details" jsonb,
	"status" text DEFAULT 'requested' NOT NULL,
	"assigned_it_membership_id" uuid,
	"scim_sync_ref" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provisioned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_it_provisioning_requests_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "it_provisioning_requests_status_check" CHECK ("it_provisioning_requests"."status" IN ('requested', 'in_progress', 'provisioned', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "it_provisioning_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "asset_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"asset_type" text NOT NULL,
	"asset_tag" text,
	"description" text,
	"status" text DEFAULT 'requested' NOT NULL,
	"assigned_at" timestamp with time zone,
	"assigned_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_asset_assignments_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "asset_assignments_status_check" CHECK ("asset_assignments"."status" IN ('requested', 'allocated', 'assigned', 'returned', 'lost'))
);
--> statement-breakpoint
ALTER TABLE "asset_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "onboarding_cases" ADD CONSTRAINT "onboarding_cases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_cases" ADD CONSTRAINT "fk_onboarding_cases_application" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_cases" ADD CONSTRAINT "fk_onboarding_cases_candidate" FOREIGN KEY ("tenant_id","candidate_id") REFERENCES "public"."candidates"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_cases" ADD CONSTRAINT "fk_onboarding_cases_buddy" FOREIGN KEY ("tenant_id","buddy_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_cases" ADD CONSTRAINT "fk_onboarding_cases_manager" FOREIGN KEY ("tenant_id","manager_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_tasks" ADD CONSTRAINT "onboarding_tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_tasks" ADD CONSTRAINT "fk_onboarding_tasks_case" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."onboarding_cases"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_tasks" ADD CONSTRAINT "fk_onboarding_tasks_assignee" FOREIGN KEY ("tenant_id","assignee_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_documents" ADD CONSTRAINT "onboarding_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_documents" ADD CONSTRAINT "onboarding_documents_document_type_id_document_types_id_fk" FOREIGN KEY ("document_type_id") REFERENCES "public"."document_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_documents" ADD CONSTRAINT "fk_onboarding_documents_case" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."onboarding_cases"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_documents" ADD CONSTRAINT "fk_onboarding_documents_verified_by" FOREIGN KEY ("tenant_id","verified_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bgv_runs" ADD CONSTRAINT "bgv_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bgv_runs" ADD CONSTRAINT "fk_bgv_runs_case" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."onboarding_cases"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bgv_results" ADD CONSTRAINT "bgv_results_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bgv_results" ADD CONSTRAINT "fk_bgv_results_run" FOREIGN KEY ("tenant_id","bgv_run_id") REFERENCES "public"."bgv_runs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "it_provisioning_requests" ADD CONSTRAINT "it_provisioning_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "it_provisioning_requests" ADD CONSTRAINT "fk_it_provisioning_requests_case" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."onboarding_cases"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "it_provisioning_requests" ADD CONSTRAINT "fk_it_provisioning_requests_assigned_it" FOREIGN KEY ("tenant_id","assigned_it_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_assignments" ADD CONSTRAINT "fk_asset_assignments_case" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."onboarding_cases"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_assignments" ADD CONSTRAINT "fk_asset_assignments_assigned_by" FOREIGN KEY ("tenant_id","assigned_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_onboarding_cases_status" ON "onboarding_cases" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_onboarding_cases_application" ON "onboarding_cases" USING btree ("tenant_id","application_id");--> statement-breakpoint
CREATE INDEX "idx_onboarding_tasks_case" ON "onboarding_tasks" USING btree ("tenant_id","case_id");--> statement-breakpoint
CREATE INDEX "idx_onboarding_tasks_type_status" ON "onboarding_tasks" USING btree ("tenant_id","task_type","status");--> statement-breakpoint
CREATE INDEX "idx_onboarding_tasks_due" ON "onboarding_tasks" USING btree ("tenant_id","due_at");--> statement-breakpoint
CREATE INDEX "idx_onboarding_documents_case" ON "onboarding_documents" USING btree ("tenant_id","case_id");--> statement-breakpoint
CREATE INDEX "idx_onboarding_documents_type" ON "onboarding_documents" USING btree ("tenant_id","document_type_id");--> statement-breakpoint
CREATE INDEX "idx_onboarding_documents_verification" ON "onboarding_documents" USING btree ("tenant_id","verification_status");--> statement-breakpoint
CREATE INDEX "idx_bgv_runs_case" ON "bgv_runs" USING btree ("tenant_id","case_id");--> statement-breakpoint
CREATE INDEX "idx_bgv_runs_status" ON "bgv_runs" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_bgv_results_run" ON "bgv_results" USING btree ("tenant_id","bgv_run_id");--> statement-breakpoint
CREATE INDEX "idx_it_provisioning_requests_case" ON "it_provisioning_requests" USING btree ("tenant_id","case_id");--> statement-breakpoint
CREATE INDEX "idx_it_provisioning_requests_status" ON "it_provisioning_requests" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_asset_assignments_case" ON "asset_assignments" USING btree ("tenant_id","case_id");--> statement-breakpoint
CREATE INDEX "idx_asset_assignments_status" ON "asset_assignments" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE POLICY "reference_read" ON "document_types" AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "onboarding_cases" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "onboarding_tasks" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "onboarding_documents" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "bgv_runs" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "bgv_results" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "it_provisioning_requests" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "asset_assignments" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
