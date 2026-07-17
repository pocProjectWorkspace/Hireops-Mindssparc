-- =====================================================================
-- 0054_int_02_confirm_link_hash.sql — INT-02 (hand-written)
--
-- Wave B / interview scheduling. Adds the candidate-confirmation
-- signed-link hash column to `interviews`. When a round is scheduled
-- (scheduleInterview / rescheduleInterview), the API mints an HMAC signed
-- link (action `candidate.confirm_interview`), stores its SHA-256 hash
-- here, and the raw token goes ONLY into the invitation email. The public
-- confirm route (POST /api/interviews/confirm/:token) looks the interview
-- up by this hash, verifies the signature, records a single-use
-- signed_link_uses row, and stamps `candidate_confirmed_at`.
--
-- INT-01 deliberately left this column out (it added no candidate-confirm
-- machinery); this is INT-02's single additive migration. Mirrors the
-- offers.accept_signed_link_token_hash column + its partial lookup index.
--
-- Additive + safe on the live staging DB (the dev Supabase project is also
-- staging): `interviews` carries no confirm hashes yet, so the column and
-- its partial index add with no backfill. Matches the hand-written style
-- of 0049/0050/0052/0053 (no drizzle meta snapshot; a table change with a
-- FORCE-RLS/audit footprint already in place from INT-01).
-- =====================================================================

ALTER TABLE public.interviews
  ADD COLUMN confirm_signed_link_token_hash text;

CREATE INDEX idx_interviews_confirm_token_hash
  ON public.interviews (confirm_signed_link_token_hash)
  WHERE confirm_signed_link_token_hash IS NOT NULL;
