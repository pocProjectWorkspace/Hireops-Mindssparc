-- =====================================================================
-- 0075_panel_02_force_rls.sql — PANEL-02 (hand-written)
--
-- Companion to 0074_panel_02_interview_prep.sql. Drizzle's .enableRLS()
-- emits ENABLE ROW LEVEL SECURITY but never FORCE; lint-rls (FND-15c)
-- requires both on every tenant-scoped table. Same pattern as every prior
-- force-rls companion (0057, 0060, 0063, 0069, 0072). interview_prep is a
-- tenant-scoped derived AI cache.
-- =====================================================================

ALTER TABLE public.interview_prep FORCE ROW LEVEL SECURITY;
