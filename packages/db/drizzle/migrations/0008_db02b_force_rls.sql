-- =====================================================================
-- 0008_db02b_force_rls.sql
--
-- Companion to 0007_living_tempest.sql. Drizzle's pgPolicy + .enableRLS()
-- emit ENABLE ROW LEVEL SECURITY but NOT FORCE. The lint-rls.ts framework
-- (FND-15c) requires both — without FORCE, the table owner bypasses RLS.
--
-- Apply FORCE to each of the four DB-02b tables. Idempotent at the SQL
-- level (a no-op for tables already forced).
-- =====================================================================

ALTER TABLE public.requisitions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.requisition_recruiters FORCE ROW LEVEL SECURITY;
ALTER TABLE public.requisition_knockouts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.requisition_state_transitions FORCE ROW LEVEL SECURITY;
