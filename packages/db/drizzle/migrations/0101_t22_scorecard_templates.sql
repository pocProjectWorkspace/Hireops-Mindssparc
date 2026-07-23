-- =====================================================================
-- 0101_t22_scorecard_templates.sql — T2.2 / G07 (hand-written)
--
-- CUSTOM scorecard VALUES: a tenant-defined scorecard rubric (an ordered set of
-- criteria) that an org can author beyond the 4 code defaults (technical,
-- manager, hr, general — SCORECARD_CRITERIA in @hireops/api-types).
--
-- WHY THIS TABLE EXISTS (read this — it is the other half of the T2.2 gap):
-- The scorecard rubric shown to (and validated against) a panelist was a FIXED
-- code constant keyed by one of 4 template names. An org could not define its
-- own scorecard values. This table holds a tenant's own scorecard keys, each
-- with a `label` and an ordered `criteria` jsonb array ([{key,label}, ...] —
-- the ScorecardCriterion shape). scorecardCriteriaFor / resolveScorecardCriteria
-- consume these; a key with no tenant row falls back to the 4 code defaults.
--
-- HONESTY — custom criteria actually DRIVE the assessment: the resolved criteria
-- (tenant custom OR code default) are SNAPSHOT onto interviews.scorecard_criteria_
-- snapshot at schedule time (0102) and the panel scorecard form renders + validates
-- against that snapshot — the custom criteria genuinely gate the assessment, they
-- are not stored-and-ignored config. Unknown scorecard keys are rejected at
-- interview_plans WRITE against {4 defaults} ∪ {these saved keys}.
--
-- `scorecard_key` is text with a lax SHAPE check (snake_case, ≤64) — it may NOT
-- collide with / redefine the 4 reserved code-default keys (enforced in the
-- procedure); the DB shape check rejects garbage/injection.
--
-- One row per (tenant, scorecard_key) — the upsert / seed conflict target.
-- Tenant-scoped + FORCE RLS + audit trigger (companions in 0103).
--
-- Hand-written (the drizzle snapshot chain is behind the schema — known debt).
-- =====================================================================

CREATE TABLE "tenant_scorecard_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scorecard_key" text NOT NULL,
	"label" text NOT NULL,
	"criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_tenant_scorecard_template_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_tenant_scorecard_template_tenant_key" UNIQUE("tenant_id","scorecard_key"),
	CONSTRAINT "tenant_scorecard_template_key_check" CHECK ("scorecard_key" ~ '^[a-z0-9_]{1,64}$')
);
--> statement-breakpoint
ALTER TABLE "tenant_scorecard_template" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_scorecard_template" ADD CONSTRAINT "tenant_scorecard_template_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tenant_scorecard_template_tenant" ON "tenant_scorecard_template" USING btree ("tenant_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_scorecard_template" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
