-- =====================================================================
-- 0102_t22_relax_scorecard_check.sql — T2.2 / G07 (hand-written)
--
-- Build B — make the scorecard value set tenant-extensible WITHOUT dropping the
-- guard entirely (dropping it would be a different config-lie).
--
-- 1) interview_plans.scorecard_template:
--    was  CHECK IN ('technical','manager','hr','general')  — a FIXED 4-value set
--    an org could not extend. RELAX to a lax SHAPE check (snake_case, ≤64) so a
--    tenant-defined scorecard key (tenant_scorecard_template, 0101) is accepted.
--    The strict membership guard MOVES to the procedure: upsertInterviewPlan (and
--    applyInterviewRoundTemplate) reject any key not in {4 code defaults} ∪ {the
--    tenant's saved scorecard keys}. So unknown keys are STILL rejected at write —
--    the DB shape check backstops garbage/injection, the procedure enforces
--    membership. No "anything goes".
--
-- 2) interviews.scorecard_template had NO DB CHECK (added nullable by 0055; the
--    only guard was the procedure-level validKeys set on saveInterviewFeedback).
--    Add the SAME lax shape check (NULL allowed) for parity — the snapshot column
--    is stamped from the already-validated plan round, so this is defence-in-depth.
--
-- 3) interviews.scorecard_criteria_snapshot (jsonb, nullable) — IMMUTABILITY.
--    doScheduleRound now RESOLVES the round's criteria (tenant custom rubric OR
--    the 4 code defaults) and SNAPSHOTS them here at schedule time. The panel
--    brief / saveInterviewFeedback / decision summary read this snapshot so that
--    editing a tenant scorecard template LATER cannot retro-change the rubric a
--    scheduled interview is scored against. Old rows (NULL snapshot) fall back to
--    live-resolve via scorecardCriteriaFor(scorecard_template), byte-identically
--    to before — including every default-template interview already scheduled.
--
-- Additive + safe on the live staging DB: constraint swaps + a nullable column
-- add. The relaxed check is strictly WIDER than the old one, so no existing row
-- is rejected.
-- =====================================================================

ALTER TABLE public.interview_plans
  DROP CONSTRAINT IF EXISTS "interview_plans_scorecard_template_check";--> statement-breakpoint

ALTER TABLE public.interview_plans
  ADD CONSTRAINT "interview_plans_scorecard_template_check"
  CHECK ("scorecard_template" ~ '^[a-z0-9_]{1,64}$');--> statement-breakpoint

ALTER TABLE public.interviews
  DROP CONSTRAINT IF EXISTS "interviews_scorecard_template_check";--> statement-breakpoint

ALTER TABLE public.interviews
  ADD CONSTRAINT "interviews_scorecard_template_check"
  CHECK ("scorecard_template" IS NULL OR "scorecard_template" ~ '^[a-z0-9_]{1,64}$');--> statement-breakpoint

ALTER TABLE public.interviews
  ADD COLUMN "scorecard_criteria_snapshot" jsonb;
