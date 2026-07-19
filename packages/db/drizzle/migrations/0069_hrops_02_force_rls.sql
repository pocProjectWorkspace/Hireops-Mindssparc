-- =====================================================================
-- 0066_hrops_02_force_rls.sql — HROPS-02 (hand-written)
--
-- Companion to 0065_hrops_02_comp_offer_desk.sql. Drizzle's .enableRLS()
-- emits ENABLE ROW LEVEL SECURITY but never FORCE; lint-rls (FND-15c)
-- requires both on every tenant-scoped table. Same pattern as every prior
-- force-rls companion (…, 0060, 0063). comp_recommendations is tenant-scoped
-- derived AI data.
-- =====================================================================

ALTER TABLE public.comp_recommendations FORCE ROW LEVEL SECURITY;
