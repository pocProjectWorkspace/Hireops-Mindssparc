-- =====================================================================
-- 0052_int_01_force_rls.sql — INT-01 (hand-written)
--
-- Companion to 0051_young_guardsmen.sql. Drizzle's .enableRLS() emits
-- ENABLE ROW LEVEL SECURITY but never FORCE; lint-rls (FND-15c) requires
-- both on every tenant-scoped table. Same pattern as every prior
-- force-rls companion (0034, 0039, 0044, 0046).
-- =====================================================================

ALTER TABLE public.interview_plans FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.interviews FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.interview_panelists FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.interview_feedback FORCE ROW LEVEL SECURITY;
