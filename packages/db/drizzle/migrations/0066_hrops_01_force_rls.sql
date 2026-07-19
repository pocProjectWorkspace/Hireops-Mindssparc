-- =====================================================================
-- 0066_hrops_01_force_rls.sql — HROPS-01 (hand-written)
--
-- Companion to 0065_loud_the_fallen.sql. Drizzle's .enableRLS() emits
-- ENABLE ROW LEVEL SECURITY but never FORCE; lint-rls (FND-15c) requires
-- both on every tenant-scoped table. Same pattern as every prior force-rls
-- companion (0034, 0039, 0044, 0046, 0052, 0057, 0060, 0063).
-- hr_round_assessments is tenant-scoped HR working data.
-- =====================================================================

ALTER TABLE public.hr_round_assessments FORCE ROW LEVEL SECURITY;
