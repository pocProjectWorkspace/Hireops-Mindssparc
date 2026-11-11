-- =====================================================================
-- 0124_application_screening_evidence.sql — PC-6 (hand-written)
--
--   application_screening_evidence   NEW — per-criterion CV screening
--                                     evidence, one row per application
--
-- ─────────────────────────────────────────────────────────────────────
-- EVIDENCE, NOT A SCORE (decision D2)
-- ─────────────────────────────────────────────────────────────────────
-- For each requisition criterion (the must-have jd_skills + the JD's
-- "required skills & qualifications" lines) the screener records a verdict
-- — met / partially_met / not_met / unclear — a short reason, and 0–2
-- VERBATIM quotes from the candidate's CV. Every quote is checked against
-- the CV text the model was shown before it is stored; one that is not a
-- verbatim substring is dropped (counted in quotes_dropped), and a met /
-- partially_met verdict left without a verified quote is stored as
-- 'unclear'. The AI never gets to assert a match it cannot show.
--
-- The legacy 0–100 applications.ai_score is still written by the SAME
-- model call (ordering + back-compat); it is no longer the primary UI.
--
-- The four verdict counts are real integer columns so list endpoints can
-- ORDER BY the deterministic evidence key in SQL:
--   (met_count * 2 + partially_met_count) DESC, not_met_count ASC
-- i.e. met (partially met = ½) descending, then not met ascending.
--
-- criteria_fingerprint = md5 of the requisition's criteria INPUTS at
-- generation time (jd_version id, required jd_skills names, JD
-- requirements section). The ai-score drain periodically compares it with
-- the requisition's current inputs; on a mismatch the row flips to 'stale'
-- and the application's ai_score_outbox row is re-queued. 'stale' evidence
-- stays readable (flagged) until the re-run overwrites it.
--
-- Conventions: compound (tenant_id, application_id) FK → applications
-- CASCADE; ONE row per application; tenant_isolation RLS + FORCE; audit
-- trigger (AI output about a person is governed state). Nothing in this
-- table is read by any automated decision — recruiters read it.
--
-- Additive only. No backfill: applications scored before this migration
-- have no evidence until they are re-queued (ai_score_outbox → pending).
-- =====================================================================

CREATE TABLE "application_screening_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"status" text DEFAULT 'done' NOT NULL,
	"criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"criteria_count" integer DEFAULT 0 NOT NULL,
	"met_count" integer DEFAULT 0 NOT NULL,
	"partially_met_count" integer DEFAULT 0 NOT NULL,
	"not_met_count" integer DEFAULT 0 NOT NULL,
	"unclear_count" integer DEFAULT 0 NOT NULL,
	"quotes_dropped" integer DEFAULT 0 NOT NULL,
	"criteria_fingerprint" text NOT NULL,
	"model" text,
	"prompt_version" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_application_screening_evidence_tenant_id_id" UNIQUE("tenant_id","id"),
	-- ONE evidence row per application — the drain's upsert target.
	CONSTRAINT "uniq_application_screening_evidence_per_application" UNIQUE("tenant_id","application_id"),
	CONSTRAINT "application_screening_evidence_status_check" CHECK ("status" IN ('done', 'stale')),
	CONSTRAINT "application_screening_evidence_counts_check" CHECK ("met_count" >= 0 AND "partially_met_count" >= 0 AND "not_met_count" >= 0 AND "unclear_count" >= 0 AND "quotes_dropped" >= 0 AND "criteria_count" = "met_count" + "partially_met_count" + "not_met_count" + "unclear_count"),
	CONSTRAINT "application_screening_evidence_criteria_array_check" CHECK (jsonb_typeof("criteria") = 'array')
);--> statement-breakpoint
ALTER TABLE "application_screening_evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "application_screening_evidence" ADD CONSTRAINT "application_screening_evidence_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_screening_evidence" ADD CONSTRAINT "fk_application_screening_evidence_application" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "application_screening_evidence" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

ALTER TABLE public.application_screening_evidence FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TRIGGER audit_application_screening_evidence
AFTER INSERT OR UPDATE OR DELETE ON public.application_screening_evidence
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
