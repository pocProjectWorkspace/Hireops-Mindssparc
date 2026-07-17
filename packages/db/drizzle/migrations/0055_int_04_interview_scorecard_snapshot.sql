-- =====================================================================
-- 0055_int_04_interview_scorecard_snapshot.sql — INT-04 (hand-written)
--
-- Wave B / interview completion + stage transitions. Snapshots the
-- scorecard_template onto `interviews` at schedule time so the panel
-- brief + scorecard validation stop resolving the template LIVE from the
-- plan round (INT-03 flagged the drift risk: interview_plans is a
-- replace-set, so editing the plan after a round is scheduled could
-- change the criteria a panelist is scored against mid-loop).
--
-- After this migration:
--   • doScheduleRound (INT-02) stamps interviews.scorecard_template from
--     the plan round it instantiates from.
--   • The INT-03 read paths (getPanelInterviewBrief, saveInterviewFeedback)
--     PREFER this snapshot and fall back to the live plan round only when
--     the snapshot is NULL (i.e. rows scheduled before this migration that
--     the backfill below couldn't match — practically none).
--
-- The backfill UPDATE stamps every EXISTING interview from its plan round
-- (matched on tenant_id + requisition_id + round_number — the same key
-- doScheduleRound and the INT-03 reads use). Interviews whose plan round
-- was already removed stay NULL and the read paths fall back to 'general',
-- exactly as INT-03 does today.
--
-- Additive + safe on the live staging DB (the dev Supabase project is
-- also staging): a nullable column add + a single backfill UPDATE, no
-- constraint that could reject existing rows. NULLABLE deliberately —
-- there is no sensible default and old/orphaned rows legitimately have no
-- snapshot. Matches the hand-written style of 0049/0050/0052/0053/0054
-- (no drizzle meta snapshot; a table change on a table whose FORCE-RLS +
-- audit footprint already exists from INT-01).
-- =====================================================================

ALTER TABLE public.interviews
  ADD COLUMN scorecard_template text;--> statement-breakpoint

UPDATE public.interviews iv
SET scorecard_template = ip.scorecard_template
FROM public.interview_plans ip
WHERE ip.tenant_id = iv.tenant_id
  AND ip.requisition_id = iv.requisition_id
  AND ip.round_number = iv.round_number
  AND iv.scorecard_template IS NULL;
