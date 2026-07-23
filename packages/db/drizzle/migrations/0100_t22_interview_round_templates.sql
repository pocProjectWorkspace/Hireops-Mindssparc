-- =====================================================================
-- 0100_t22_interview_round_templates.sql — T2.2 / G07 (hand-written)
--
-- TENANT-LEVEL interview ROUND templates: the org's DEFAULT interview loop,
-- authored once, that SEEDS a new requisition's `interview_plans` instead of
-- every recruiter building the loop from scratch per req.
--
-- WHY THIS TABLE EXISTS (read this — it is half of the T2.2 gap):
-- `interview_plans` is PER-REQUISITION — an ordered set of rounds authored on a
-- specific req (upsertInterviewPlan). There was NO tenant-level default loop to
-- seed a new req from. This table is that default: ordered rounds (round_number,
-- round_name, duration, mode, scorecard_template_key, competency_focus) that the
-- new `applyInterviewRoundTemplate` procedure copies into a requisition's
-- interview_plans.
--
-- HONESTY — genuinely CONSUMED, real fallback: applyInterviewRoundTemplate reads
-- these rows and WRITES interview_plans (a real seed, not a stored-and-ignored
-- knob). A tenant with NO template rows gets `applied:false` and builds the plan
-- from scratch via upsertInterviewPlan exactly as today (byte-identical fallback).
--
-- `scorecard_template_key` is text with a lax SHAPE check only (snake_case, ≤64):
-- it may name one of the 4 code-default scorecards OR a tenant-defined scorecard
-- key (tenant_scorecard_template, 0101). Membership in {4 defaults} ∪ {tenant's
-- saved keys} is enforced at WRITE by the procedure (applyInterviewRoundTemplate
-- + upsertInterviewPlan) — the DB shape check rejects garbage/injection, the
-- procedure rejects unknown keys. Same tracked-vs-gated discipline as G05.
--
-- `mode` uses the text + CHECK convention (NOT pgEnum) — HANDOVER reality #114.
--
-- One row per (tenant, round_number) — the ordered loop, the replace-set /
-- seed conflict target. Tenant-scoped + FORCE RLS + audit trigger (companions
-- in 0103), like every tenant-editable config table (market_benchmarks pattern).
--
-- Hand-written (the drizzle snapshot chain is behind the schema — known debt).
-- =====================================================================

CREATE TABLE "tenant_interview_round_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"round_number" integer NOT NULL,
	"round_name" text NOT NULL,
	"duration_minutes" integer DEFAULT 60 NOT NULL,
	"mode" text DEFAULT 'video' NOT NULL,
	"scorecard_template_key" text NOT NULL,
	"competency_focus" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_tenant_interview_round_template_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_tenant_interview_round_template_tenant_round" UNIQUE("tenant_id","round_number"),
	CONSTRAINT "tenant_interview_round_template_mode_check" CHECK ("mode" IN ('video', 'onsite', 'phone')),
	CONSTRAINT "tenant_interview_round_template_scorecard_key_check" CHECK ("scorecard_template_key" ~ '^[a-z0-9_]{1,64}$')
);
--> statement-breakpoint
ALTER TABLE "tenant_interview_round_template" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_interview_round_template" ADD CONSTRAINT "tenant_interview_round_template_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tenant_interview_round_template_tenant" ON "tenant_interview_round_template" USING btree ("tenant_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_interview_round_template" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
