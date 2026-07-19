-- =====================================================================
-- 0065_hrops_03_documents_notes_policies.sql — HROPS-03 (hand-written)
--
-- Three additive tenant-scoped tables:
--   application_documents — pre-offer document verification (requested →
--     uploaded → verified | rejected), the recruiting-side twin of
--     onboarding_documents keyed on the APPLICATION.
--   hr_case_notes         — free-text HR-ops notes on an application's case;
--     the audit trigger (0067) turns each insert into a real audit_logs event.
--   hr_policy_documents   — the curated templates & policies library.
--
-- Companion migrations: 0066 (FORCE RLS) + 0067 (audit triggers). Same three-
-- file shape as HRHEAD-02 (0062/0063/0064).
--
-- NOTE (parallel-ticket coordination): two other tickets also add migrations
-- this pass — the 0065/0066/0067 filenames + journal idx may need renumbering
-- at reconciliation. Table names are unique to this ticket, so no DDL clash.
-- =====================================================================

CREATE TABLE "application_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"document_type_id" uuid NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"rejection_reason" text,
	"requested_by_membership_id" uuid,
	"verified_by_membership_id" uuid,
	"verified_at" timestamp with time zone,
	"storage_ref" text,
	"file_name" text,
	"mime_type" text,
	"size_bytes" bigint,
	"encryption_key_ref" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_application_documents_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_application_documents_app_type" UNIQUE("tenant_id","application_id","document_type_id"),
	CONSTRAINT "application_documents_status_check" CHECK ("application_documents"."status" IN ('requested', 'uploaded', 'verified', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "application_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_case_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"note" text NOT NULL,
	"author_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_hr_case_notes_tenant_id_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "hr_case_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_policy_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"summary" text NOT NULL,
	"body_md" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_hr_policy_documents_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_hr_policy_documents_tenant_title" UNIQUE("tenant_id","title"),
	CONSTRAINT "hr_policy_documents_category_check" CHECK ("hr_policy_documents"."category" IN ('offers', 'benefits', 'policies'))
);
--> statement-breakpoint
ALTER TABLE "hr_policy_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "application_documents" ADD CONSTRAINT "application_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_documents" ADD CONSTRAINT "application_documents_document_type_id_document_types_id_fk" FOREIGN KEY ("document_type_id") REFERENCES "public"."document_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_documents" ADD CONSTRAINT "fk_application_documents_application" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_documents" ADD CONSTRAINT "fk_application_documents_requested_by" FOREIGN KEY ("tenant_id","requested_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_documents" ADD CONSTRAINT "fk_application_documents_verified_by" FOREIGN KEY ("tenant_id","verified_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_case_notes" ADD CONSTRAINT "hr_case_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_case_notes" ADD CONSTRAINT "fk_hr_case_notes_application" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_case_notes" ADD CONSTRAINT "fk_hr_case_notes_author" FOREIGN KEY ("tenant_id","author_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_policy_documents" ADD CONSTRAINT "hr_policy_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_application_documents_app" ON "application_documents" USING btree ("tenant_id","application_id");--> statement-breakpoint
CREATE INDEX "idx_application_documents_status" ON "application_documents" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_case_notes_app_chrono" ON "hr_case_notes" USING btree ("tenant_id","application_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_hr_policy_documents_category" ON "hr_policy_documents" USING btree ("tenant_id","category");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "application_documents" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "hr_case_notes" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "hr_policy_documents" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
