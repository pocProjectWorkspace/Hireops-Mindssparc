-- =====================================================================
-- 0011_integration_credentials_force_rls.sql
--
-- Companion to 0010_dear_colonel_america.sql. Drizzle's pgPolicy +
-- .enableRLS() emit ENABLE ROW LEVEL SECURITY but not FORCE. The
-- lint-rls.ts framework (FND-15c) requires both — without FORCE, the
-- table owner bypasses RLS.
-- =====================================================================

ALTER TABLE public.integration_credentials FORCE ROW LEVEL SECURITY;
