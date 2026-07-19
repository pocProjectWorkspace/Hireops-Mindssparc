-- =====================================================================
-- 0066_hrops_03_force_rls.sql — HROPS-03 (hand-written)
--
-- Companion to 0065. Drizzle's .enableRLS() emits ENABLE ROW LEVEL SECURITY
-- but never FORCE; lint-rls (FND-15c) requires both on every tenant-scoped
-- table. Same pattern as every prior force-rls companion (…, 0060, 0063).
-- All three HROPS-03 tables are tenant-scoped (each carries tenant_id + a
-- tenant_isolation policy), so all three get FORCE.
-- =====================================================================

ALTER TABLE public.application_documents FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.hr_case_notes FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.hr_policy_documents FORCE ROW LEVEL SECURITY;
