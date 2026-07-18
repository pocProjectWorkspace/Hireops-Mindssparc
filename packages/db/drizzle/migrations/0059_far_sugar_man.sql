-- =====================================================================
-- 0059_far_sugar_man.sql — OFFBOARD-01 offboarding pillar (schema)
--
-- Drizzle-generated CREATE TABLE / FK / INDEX / POLICY for the offboarding
-- table group (offboarding_cases, offboarding_tasks, exit_interviews,
-- asset_returns, final_settlements). Architecture.md §5.1 "-- Offboarding"
-- block; requirements.md §8.
--
-- HAND-TRIMMED per HANDOVER reality #83: drizzle-kit diffs against the
-- latest snapshot (0051), which predates the hand-written 0054/0055
-- (interviews.scorecard_template + interviews.confirm_signed_link_token_hash
-- + its partial index) and 0056 (candidate_accounts). The generator
-- therefore re-emitted CREATE TABLE / FK / INDEX / POLICY for
-- candidate_accounts and the two interviews ALTER-COLUMN / index statements
-- — all removed here so this migration is purely additive against the live
-- dev/staging DB. The 0059 snapshot retains the FULL schema (candidate_accounts
-- + the interviews columns included) so it is a correct baseline for the next
-- generate — the baseline advances from 0051 to 0059. FORCE RLS + audit
-- triggers are the hand-written companions 0060/0061.
-- =====================================================================

CREATE TABLE "offboarding_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"application_id" uuid,
	"onboarding_case_id" uuid,
	"initiation_type" text NOT NULL,
	"status" text DEFAULT 'initiated' NOT NULL,
	"notice_start_date" date,
	"last_working_day" date,
	"reason" text,
	"initiated_by_membership_id" uuid NOT NULL,
	"manager_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_offboarding_cases_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "offboarding_cases_initiation_type_check" CHECK ("offboarding_cases"."initiation_type" IN ('resignation', 'termination', 'end_of_contract')),
	CONSTRAINT "offboarding_cases_status_check" CHECK ("offboarding_cases"."status" IN ('initiated', 'notice_period', 'clearance', 'completed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "offboarding_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "offboarding_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"task_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"title" text NOT NULL,
	"assignee_membership_id" uuid,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"blocked_reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_offboarding_tasks_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "offboarding_tasks_task_type_check" CHECK ("offboarding_tasks"."task_type" IN ('knowledge_transfer', 'asset_return', 'access_revocation', 'final_settlement', 'exit_interview', 'manager_signoff', 'hr_clearance')),
	CONSTRAINT "offboarding_tasks_status_check" CHECK ("offboarding_tasks"."status" IN ('pending', 'in_progress', 'completed', 'blocked', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "offboarding_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "exit_interviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"scheduled_at" timestamp with time zone,
	"conducted_by_membership_id" uuid,
	"structured_responses" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"free_text" text,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_exit_interviews_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_exit_interviews_tenant_case" UNIQUE("tenant_id","case_id")
);
--> statement-breakpoint
ALTER TABLE "exit_interviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "asset_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"asset_type" text NOT NULL,
	"asset_tag" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"returned_at" timestamp with time zone,
	"received_by_membership_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_asset_returns_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "asset_returns_status_check" CHECK ("asset_returns"."status" IN ('pending', 'returned', 'written_off', 'lost'))
);
--> statement-breakpoint
ALTER TABLE "asset_returns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "final_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"amount_minor" bigint,
	"currency" char(3),
	"breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approved_by_membership_id" uuid,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_final_settlements_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_final_settlements_tenant_case" UNIQUE("tenant_id","case_id"),
	CONSTRAINT "final_settlements_status_check" CHECK ("final_settlements"."status" IN ('pending', 'calculated', 'approved', 'paid'))
);
--> statement-breakpoint
ALTER TABLE "final_settlements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "offboarding_cases" ADD CONSTRAINT "offboarding_cases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_cases" ADD CONSTRAINT "fk_offboarding_cases_candidate" FOREIGN KEY ("tenant_id","candidate_id") REFERENCES "public"."candidates"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_cases" ADD CONSTRAINT "fk_offboarding_cases_application" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_cases" ADD CONSTRAINT "fk_offboarding_cases_onboarding_case" FOREIGN KEY ("tenant_id","onboarding_case_id") REFERENCES "public"."onboarding_cases"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_cases" ADD CONSTRAINT "fk_offboarding_cases_initiated_by" FOREIGN KEY ("tenant_id","initiated_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_cases" ADD CONSTRAINT "fk_offboarding_cases_manager" FOREIGN KEY ("tenant_id","manager_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_tasks" ADD CONSTRAINT "offboarding_tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_tasks" ADD CONSTRAINT "fk_offboarding_tasks_case" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."offboarding_cases"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_tasks" ADD CONSTRAINT "fk_offboarding_tasks_assignee" FOREIGN KEY ("tenant_id","assignee_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_interviews" ADD CONSTRAINT "exit_interviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_interviews" ADD CONSTRAINT "fk_exit_interviews_case" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."offboarding_cases"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_interviews" ADD CONSTRAINT "fk_exit_interviews_conducted_by" FOREIGN KEY ("tenant_id","conducted_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_returns" ADD CONSTRAINT "asset_returns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_returns" ADD CONSTRAINT "fk_asset_returns_case" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."offboarding_cases"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_returns" ADD CONSTRAINT "fk_asset_returns_received_by" FOREIGN KEY ("tenant_id","received_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "final_settlements" ADD CONSTRAINT "final_settlements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "final_settlements" ADD CONSTRAINT "fk_final_settlements_case" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."offboarding_cases"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "final_settlements" ADD CONSTRAINT "fk_final_settlements_approved_by" FOREIGN KEY ("tenant_id","approved_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_offboarding_cases_active_per_candidate" ON "offboarding_cases" USING btree ("tenant_id","candidate_id") WHERE status <> 'cancelled';--> statement-breakpoint
CREATE INDEX "idx_offboarding_cases_status" ON "offboarding_cases" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_offboarding_cases_candidate" ON "offboarding_cases" USING btree ("tenant_id","candidate_id");--> statement-breakpoint
CREATE INDEX "idx_offboarding_cases_onboarding_case" ON "offboarding_cases" USING btree ("tenant_id","onboarding_case_id");--> statement-breakpoint
CREATE INDEX "idx_offboarding_tasks_case" ON "offboarding_tasks" USING btree ("tenant_id","case_id");--> statement-breakpoint
CREATE INDEX "idx_offboarding_tasks_type_status" ON "offboarding_tasks" USING btree ("tenant_id","task_type","status");--> statement-breakpoint
CREATE INDEX "idx_offboarding_tasks_due" ON "offboarding_tasks" USING btree ("tenant_id","due_at");--> statement-breakpoint
CREATE INDEX "idx_exit_interviews_case" ON "exit_interviews" USING btree ("tenant_id","case_id");--> statement-breakpoint
CREATE INDEX "idx_asset_returns_case" ON "asset_returns" USING btree ("tenant_id","case_id");--> statement-breakpoint
CREATE INDEX "idx_asset_returns_status" ON "asset_returns" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_final_settlements_status" ON "final_settlements" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "offboarding_cases" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "offboarding_tasks" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "exit_interviews" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "asset_returns" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "final_settlements" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
