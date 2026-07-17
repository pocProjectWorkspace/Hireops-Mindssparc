-- =====================================================================
-- 0057_cand_01_force_rls.sql — CAND-01 (hand-written)
--
-- Companion to 0056. lint-rls (FND-15c) requires ENABLE *and* FORCE on
-- every tenant-scoped table; the CREATE only enabled it. Same pattern as
-- every prior force-rls companion (0034, 0039, 0044, 0046, 0052).
-- =====================================================================

ALTER TABLE public.candidate_accounts FORCE ROW LEVEL SECURITY;
