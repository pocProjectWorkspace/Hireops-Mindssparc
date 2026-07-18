-- =====================================================================
-- 0063_hrhead_02_force_rls.sql — HRHEAD-02 (hand-written)
--
-- Companion to 0062_abnormal_talon.sql. Drizzle's .enableRLS() emits
-- ENABLE ROW LEVEL SECURITY but never FORCE; lint-rls (FND-15c) requires
-- both on every tenant-scoped table. Same pattern as every prior force-rls
-- companion (0034, 0039, 0044, 0046, 0052, 0057, 0060). Both HRHEAD-02
-- tables are tenant-scoped (market_benchmarks is tenant-editable reference
-- data, not a shared reference table like document_types).
-- =====================================================================

ALTER TABLE public.market_benchmarks FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.requisition_feasibility FORCE ROW LEVEL SECURITY;
