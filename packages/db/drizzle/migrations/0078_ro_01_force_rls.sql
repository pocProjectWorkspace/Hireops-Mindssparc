-- =====================================================================
-- 0078_ro_01_force_rls.sql — RO-01 (hand-written)
--
-- Companion to 0077_ro_01_req_revision_suggestions.sql. Drizzle's
-- .enableRLS() emits ENABLE ROW LEVEL SECURITY but never FORCE; lint-rls
-- (FND-15c) requires both on every tenant-scoped table. Same pattern as
-- every prior force-rls companion (…, 0069, 0072, 0075).
-- req_revision_suggestions is tenant-scoped derived AI data.
-- =====================================================================

ALTER TABLE public.req_revision_suggestions FORCE ROW LEVEL SECURITY;
