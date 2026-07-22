-- =====================================================================
-- 0099_t21_force_rls_audit.sql — T2.1 / G05 (hand-written)
--
-- Companion to 0098_t21_candidate_field_policy.sql. Two things every
-- tenant-scoped config table gets, folded into one migration (the
-- 0092_t11_force_rls_audit precedent):
--   1. FORCE ROW LEVEL SECURITY — drizzle's .enableRLS() emits ENABLE but
--      never FORCE; lint-rls (FND-15c) requires both.
--   2. audit_record_change() trigger — an admin requiredness/gate edit is
--      audit-worthy, same treatment as market_benchmarks (0064),
--      tenant_application_sources (0092), and every other tenant-editable
--      config table.
-- =====================================================================

ALTER TABLE public.candidate_field_policy FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TRIGGER audit_candidate_field_policy
AFTER INSERT OR UPDATE OR DELETE ON public.candidate_field_policy
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
