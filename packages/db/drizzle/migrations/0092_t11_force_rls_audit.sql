-- =====================================================================
-- 0092_t11_force_rls_audit.sql — T1.1 / G04 (hand-written)
--
-- Companion to 0091_t11_tenant_application_sources.sql. Two things every
-- tenant-scoped config table gets, folded into one migration (the
-- 0087_recr_03_force_rls_audit precedent):
--   1. FORCE ROW LEVEL SECURITY — drizzle's .enableRLS() emits ENABLE but
--      never FORCE; lint-rls (FND-15c) requires both.
--   2. audit_record_change() trigger — an admin enable/label/config edit is
--      audit-worthy, same treatment as market_benchmarks (0064) and every
--      other tenant-editable domain table.
-- =====================================================================

ALTER TABLE public.tenant_application_sources FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TRIGGER audit_tenant_application_sources
AFTER INSERT OR UPDATE OR DELETE ON public.tenant_application_sources
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
