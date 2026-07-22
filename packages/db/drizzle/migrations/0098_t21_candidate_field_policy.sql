-- =====================================================================
-- 0098_t21_candidate_field_policy.sql — T2.1 / G05 (hand-written)
--
-- The REQUIRED-CANDIDATE-FIELD policy: a tenant's editable CONFIG over the
-- fixed seven-field Missing-Info CATALOG (apps/api/src/lib/missing-info.ts —
-- MISSING_INFO_FIELDS). The code constant stays the canonical catalog (which
-- fields are trackable, what each reads from); this table lets an org override
-- a field's `requiredness` (required | optional) and the stage a missing
-- REQUIRED field blocks (`blocks_advance_stage`, or NULL for tracked-only).
--
-- field_key is text + CHECK (NOT a pgEnum — HANDOVER reality) pinned to the
-- seven known keys: an org configures the catalog, it never invents fields.
-- One row per (tenant, field_key); a field with no row falls back to the code
-- default (byte-identical to today).
--
-- HONESTY: saving a row with a non-null blocks_advance_stage turns tracking
-- into a real server-side GATE (router transitionApplicationStage + the
-- offer-desk offer_drafted transition refuse advancement when the field is
-- missing). The code-owned catalog defaults are tracking hints, not gates,
-- until a tenant opts in by saving them — tenants with no policy rows advance
-- exactly as before.
--
-- Hand-written (the drizzle snapshot chain is behind the schema — known debt).
-- Force-RLS + audit-trigger companion lands in 0099.
-- =====================================================================

CREATE TABLE "candidate_field_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"requiredness" text DEFAULT 'optional' NOT NULL,
	"blocks_advance_stage" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_candidate_field_policy_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_candidate_field_policy_tenant_field" UNIQUE("tenant_id","field_key"),
	CONSTRAINT "candidate_field_policy_field_key_check" CHECK ("field_key" IN ('expected_salary', 'notice_period', 'availability_date', 'work_authorization', 'current_location', 'skills_confirmation', 'education_year')),
	CONSTRAINT "candidate_field_policy_requiredness_check" CHECK ("requiredness" IN ('required', 'optional')),
	CONSTRAINT "candidate_field_policy_blocks_advance_stage_check" CHECK ("blocks_advance_stage" IS NULL OR "blocks_advance_stage" IN ('application_received', 'ai_screening', 'recruiter_review', 'shortlisted', 'tech_interview', 'hr_round', 'offer_drafted', 'offer_accepted', 'offer_declined', 'withdrawn', 'recruiter_rejected'))
);
--> statement-breakpoint
ALTER TABLE "candidate_field_policy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "candidate_field_policy" ADD CONSTRAINT "candidate_field_policy_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_candidate_field_policy_tenant" ON "candidate_field_policy" USING btree ("tenant_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "candidate_field_policy" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
