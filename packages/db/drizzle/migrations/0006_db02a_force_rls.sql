-- =====================================================================
-- 0006_db02a_force_rls.sql
--
-- Companion to 0005_tranquil_scream.sql. Drizzle's pgPolicy + .enableRLS()
-- emit ALTER TABLE ... ENABLE ROW LEVEL SECURITY but NOT
-- ALTER TABLE ... FORCE ROW LEVEL SECURITY. The lint-rls.ts framework
-- (FND-15c) requires both — without FORCE, the table owner bypasses RLS
-- and policies don't apply to administrative writes.
--
-- Apply FORCE to each of the four DB-02a tables. This is idempotent at
-- the SQL level; running it twice is a no-op for tables already forced.
-- =====================================================================

ALTER TABLE public.headcount_envelopes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.positions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.jd_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.jd_skills FORCE ROW LEVEL SECURITY;
