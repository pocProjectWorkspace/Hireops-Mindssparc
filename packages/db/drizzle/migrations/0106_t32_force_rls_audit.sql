-- =====================================================================
-- 0106_t32_force_rls_audit.sql — T3.2 / G15 (hand-written)
--
-- Companion to 0105_t32_comp_bands.sql. Two things every tenant-scoped config
-- table gets, folded into one migration (the 0099/0103 precedent):
--   1. FORCE ROW LEVEL SECURITY — drizzle's .enableRLS() emits ENABLE but never
--      FORCE; lint-rls (FND-15c) requires both.
--   2. audit_record_change() trigger — an admin / hr_head edit to the tenant's
--      comp-band library is audit-worthy, same treatment as market_benchmarks
--      (0064), candidate_field_policy (0099), and every other tenant-editable
--      config table.
-- =====================================================================

ALTER TABLE public.comp_bands FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TRIGGER audit_comp_bands
AFTER INSERT OR UPDATE OR DELETE ON public.comp_bands
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
