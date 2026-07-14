-- =====================================================================
-- 0046_onboard_01_force_rls.sql — ONBOARD-01 (hand-written)
--
-- Companion to 0045_dashing_magneto.sql. Drizzle's .enableRLS() emits
-- ENABLE ROW LEVEL SECURITY but never FORCE; lint-rls (FND-15c) requires
-- both on every table — tenant-scoped AND the platform-allowlisted
-- document_types reference table. Same pattern as every prior force-rls
-- companion (0034, 0039, 0044).
-- =====================================================================

ALTER TABLE public.document_types FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.onboarding_cases FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.onboarding_tasks FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.onboarding_documents FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.bgv_runs FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.bgv_results FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.it_provisioning_requests FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.asset_assignments FORCE ROW LEVEL SECURITY;
