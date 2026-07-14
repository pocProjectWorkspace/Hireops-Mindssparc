-- =====================================================================
-- 0049_onboard_02_case_application_unique.sql — ONBOARD-02 (hand-written)
--
-- Purely-additive guard: at most ONE onboarding_case per (tenant,
-- application). ONBOARD-02 auto-creates a case when an offer is accepted;
-- this UNIQUE is what makes that creation idempotent — the shared helper
-- inserts with ON CONFLICT (tenant_id, application_id) DO NOTHING, so a
-- double-accept or a manual backfill can never open a second case for the
-- same hire.
--
-- Additive + safe on the live staging DB: onboarding_cases is empty
-- (ONBOARD-01 landed schema only; no case rows are written until this
-- ticket), so the constraint adds with no backfill conflict. Matches the
-- hand-written style of 0046–0048 (no drizzle meta snapshot).
-- =====================================================================

ALTER TABLE public.onboarding_cases
  ADD CONSTRAINT uniq_onboarding_cases_tenant_application
  UNIQUE (tenant_id, application_id);
