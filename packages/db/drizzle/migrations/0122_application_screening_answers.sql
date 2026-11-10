-- =====================================================================
-- 0122_application_screening_answers.sql — PC-7 (hand-written)
--
-- Per-APPLICATION screening answers: the facts a recruiter screens a
-- 400-CV role on before reading a single CV — notice period, current and
-- expected pay, and where the candidate is now. They live on the
-- application (not the candidate) because each is an answer IN TIME for a
-- given requisition: the same person can be on 90 days' notice when they
-- apply to one role and 30 days when they apply to the next.
--
--   notice_period_days            integer NULL, 0..365
--   current_salary_inr_paise      bigint  NULL, >= 0  — current CTC
--   current_location              text    NULL, <= 200 chars
--   screening_answers_source      text    NULL, who supplied the answers:
--                                   candidate | recruiter | partner |
--                                   import | parsed_cv
--   screening_answers_updated_at  timestamptz NULL
--
-- EXPECTED pay is NOT added here: applications.expected_salary_inr_paise
-- (0068, HROPS-02) already is the per-application expected CTC, and the
-- comp desk, missing-info tracker and candidate profile all read it.
-- PC-7 writes the same column — one home per fact.
--
-- Money follows the existing comp convention exactly: minor units in a
-- bigint whose column name carries the currency (offers.base_salary_inr_paise,
-- applications.expected_salary_inr_paise). No currency column — no comp
-- table has one today, and multi-currency is a separate piece of work.
--
-- screening_answers_source records the LAST writer of the answers. A notice
-- period pre-filled from the parsed CV with nothing else supplied is
-- 'parsed_cv'; anything a person typed overrides that.
--
-- Also: candidate_field_policy's field_key CHECK is unchanged — notice_period,
-- expected_salary and current_location are already catalog keys there, and the
-- apply form reads those rows to decide which screening questions are required.
--
-- All columns are NULLABLE with no default, so every existing row and every
-- pre-0122 insert path stays valid (additive contract). applications already
-- carries tenant_isolation + FORCE RLS + its audit trigger; ADD COLUMN does not
-- disturb any of them — no companion RLS / audit migration needed.
-- =====================================================================

ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "notice_period_days" integer;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "current_salary_inr_paise" bigint;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "current_location" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "screening_answers_source" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "screening_answers_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "applications" DROP CONSTRAINT IF EXISTS "applications_notice_period_days_check";--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_notice_period_days_check" CHECK ("notice_period_days" IS NULL OR ("notice_period_days" >= 0 AND "notice_period_days" <= 365));--> statement-breakpoint
ALTER TABLE "applications" DROP CONSTRAINT IF EXISTS "applications_current_salary_check";--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_current_salary_check" CHECK ("current_salary_inr_paise" IS NULL OR "current_salary_inr_paise" >= 0);--> statement-breakpoint
ALTER TABLE "applications" DROP CONSTRAINT IF EXISTS "applications_current_location_check";--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_current_location_check" CHECK ("current_location" IS NULL OR char_length("current_location") <= 200);--> statement-breakpoint
ALTER TABLE "applications" DROP CONSTRAINT IF EXISTS "applications_screening_answers_source_check";--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_screening_answers_source_check" CHECK ("screening_answers_source" IS NULL OR "screening_answers_source" IN ('candidate', 'recruiter', 'partner', 'import', 'parsed_cv'));
