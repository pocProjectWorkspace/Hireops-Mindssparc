-- =====================================================================
-- 0060_offboard_01_force_rls.sql — OFFBOARD-01 (hand-written)
--
-- Companion to 0059_far_sugar_man.sql. Drizzle's .enableRLS() emits
-- ENABLE ROW LEVEL SECURITY but never FORCE; lint-rls (FND-15c) requires
-- both on every tenant-scoped table. Same pattern as every prior force-rls
-- companion (0034, 0039, 0044, 0046, 0052, 0057). All five offboarding
-- tables are tenant-scoped (no reference table in this group).
-- =====================================================================

ALTER TABLE public.offboarding_cases FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.offboarding_tasks FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.exit_interviews FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.asset_returns FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.final_settlements FORCE ROW LEVEL SECURITY;
