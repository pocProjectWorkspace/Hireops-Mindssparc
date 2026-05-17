-- =====================================================================
-- 0034_module_4_force_rls.sql — Module 4 offers + workday_sync_outbox
--
-- Companion to 0033_demonic_marrow.sql. Drizzle's pgPolicy +
-- .enableRLS() emit ENABLE ROW LEVEL SECURITY but not FORCE; FND-15c's
-- lint-rls requires both.
-- =====================================================================

ALTER TABLE public.offers FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.workday_sync_outbox FORCE ROW LEVEL SECURITY;
