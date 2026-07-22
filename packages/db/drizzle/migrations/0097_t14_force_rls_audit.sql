-- =====================================================================
-- 0097_t14_force_rls_audit.sql — T1.4 / G09 (hand-written)
--
-- Companion to 0096_t14_email_template_overrides.sql. Two things every
-- tenant-scoped config table gets, folded into one migration (the
-- 0092_t11_force_rls_audit / 0095_t12_force_rls_audit precedent):
--   1. FORCE ROW LEVEL SECURITY — drizzle's .enableRLS() emits ENABLE but
--      never FORCE; lint-rls (FND-15c) requires both.
--   2. audit_record_change() trigger — an admin subject/slot copy edit is
--      audit-worthy, same treatment as market_benchmarks (0064),
--      tenant_application_sources (0092), and jd_templates (0095).
-- =====================================================================

ALTER TABLE public.tenant_email_template_overrides FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TRIGGER audit_tenant_email_template_overrides
AFTER INSERT OR UPDATE OR DELETE ON public.tenant_email_template_overrides
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
