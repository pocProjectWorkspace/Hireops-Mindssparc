-- =====================================================================
-- 0051_young_guardsmen.sql — INT-01 Wave B interview loop (schema)
--
-- Drizzle-generated CREATE TABLE / FK / INDEX / POLICY for the four
-- interview tables (interview_plans, interviews, interview_panelists,
-- interview_feedback).
--
-- HAND-TRIMMED per HANDOVER reality #83: drizzle-kit diffs against the
-- 0045 snapshot, which predates the hand-written 0049 (onboarding_cases
-- (tenant_id, application_id) unique) and 0050 (tenant_role ADD VALUE
-- 'hr_head'). The generator therefore re-emitted both — removed here so
-- this migration is purely additive against the live dev/staging DB
-- (both are already applied). The 0051 snapshot retains them, so it is a
-- correct baseline for the next generate. FORCE RLS + audit triggers are
-- the hand-written companions 0052/0053 (the 0046/0047 pattern).
--
-- (Removed vs generator output: `ALTER TYPE tenant_role ADD VALUE
-- 'hr_head'` — would fail as a duplicate / non-IF-NOT-EXISTS re-add — and
-- `ALTER TABLE onboarding_cases ADD CONSTRAINT
-- uniq_onboarding_cases_tenant_application`.)
-- =====================================================================

CREATE TABLE "interview_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requisition_id" uuid NOT NULL,
	"round_number" integer NOT NULL,
	"round_name" text NOT NULL,
	"duration_minutes" integer DEFAULT 60 NOT NULL,
	"mode" text NOT NULL,
	"scorecard_template" text NOT NULL,
	"competency_focus" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_panel_membership_ids" uuid[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_interview_plans_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_interview_plans_req_round" UNIQUE("tenant_id","requisition_id","round_number"),
	CONSTRAINT "interview_plans_mode_check" CHECK ("interview_plans"."mode" IN ('video', 'onsite', 'phone')),
	CONSTRAINT "interview_plans_scorecard_template_check" CHECK ("interview_plans"."scorecard_template" IN ('technical', 'manager', 'hr', 'general'))
);
--> statement-breakpoint
ALTER TABLE "interview_plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "interviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"requisition_id" uuid NOT NULL,
	"round_number" integer NOT NULL,
	"round_name" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"scheduled_start" timestamp with time zone,
	"scheduled_end" timestamp with time zone,
	"duration_minutes" integer DEFAULT 60 NOT NULL,
	"mode" text NOT NULL,
	"meeting_url" text,
	"external_booking_ref" text,
	"candidate_confirmed_at" timestamp with time zone,
	"created_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_interviews_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "interviews_status_check" CHECK ("interviews"."status" IN ('scheduled', 'completed', 'cancelled', 'no_show')),
	CONSTRAINT "interviews_mode_check" CHECK ("interviews"."mode" IN ('video', 'onsite', 'phone'))
);
--> statement-breakpoint
ALTER TABLE "interviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "interview_panelists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"interview_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"is_lead" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_interview_panelists_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_interview_panelists_interview_membership" UNIQUE("tenant_id","interview_id","membership_id")
);
--> statement-breakpoint
ALTER TABLE "interview_panelists" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "interview_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"interview_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"scorecard" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"strengths" text,
	"concerns" text,
	"notes" text,
	"recommendation" text,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_interview_feedback_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_interview_feedback_interview_membership" UNIQUE("tenant_id","interview_id","membership_id"),
	CONSTRAINT "interview_feedback_recommendation_check" CHECK ("interview_feedback"."recommendation" IN ('strong_yes', 'yes', 'hold', 'no'))
);
--> statement-breakpoint
ALTER TABLE "interview_feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "interview_plans" ADD CONSTRAINT "interview_plans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_plans" ADD CONSTRAINT "fk_interview_plans_requisition" FOREIGN KEY ("tenant_id","requisition_id") REFERENCES "public"."requisitions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "fk_interviews_application" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "fk_interviews_requisition" FOREIGN KEY ("tenant_id","requisition_id") REFERENCES "public"."requisitions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "fk_interviews_created_by" FOREIGN KEY ("tenant_id","created_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_panelists" ADD CONSTRAINT "interview_panelists_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_panelists" ADD CONSTRAINT "fk_interview_panelists_interview" FOREIGN KEY ("tenant_id","interview_id") REFERENCES "public"."interviews"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_panelists" ADD CONSTRAINT "fk_interview_panelists_membership" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_feedback" ADD CONSTRAINT "interview_feedback_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_feedback" ADD CONSTRAINT "fk_interview_feedback_interview" FOREIGN KEY ("tenant_id","interview_id") REFERENCES "public"."interviews"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_feedback" ADD CONSTRAINT "fk_interview_feedback_membership" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_interview_plans_requisition" ON "interview_plans" USING btree ("tenant_id","requisition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_interviews_application_round_active" ON "interviews" USING btree ("tenant_id","application_id","round_number") WHERE status <> 'cancelled';--> statement-breakpoint
CREATE INDEX "idx_interviews_application" ON "interviews" USING btree ("tenant_id","application_id");--> statement-breakpoint
CREATE INDEX "idx_interviews_requisition" ON "interviews" USING btree ("tenant_id","requisition_id");--> statement-breakpoint
CREATE INDEX "idx_interviews_status" ON "interviews" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_interviews_scheduled_start" ON "interviews" USING btree ("tenant_id","scheduled_start");--> statement-breakpoint
CREATE INDEX "idx_interview_panelists_interview" ON "interview_panelists" USING btree ("tenant_id","interview_id");--> statement-breakpoint
CREATE INDEX "idx_interview_panelists_membership" ON "interview_panelists" USING btree ("tenant_id","membership_id");--> statement-breakpoint
CREATE INDEX "idx_interview_feedback_interview" ON "interview_feedback" USING btree ("tenant_id","interview_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "interview_plans" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "interviews" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "interview_panelists" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "interview_feedback" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());