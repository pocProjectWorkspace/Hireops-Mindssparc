-- =====================================================================
-- 0108_t33_force_rls_audit.sql — T3.3 / G16 (hand-written)
--
-- Companion to 0107_t33_panel_pools.sql. Two things every tenant-scoped config
-- table gets, folded into one migration (the 0103/0106 precedent):
--   1. FORCE ROW LEVEL SECURITY — drizzle's .enableRLS() emits ENABLE but never
--      FORCE; lint-rls (FND-15c) requires both.
--   2. audit_record_change() trigger — an admin / recruiter edit to the tenant's
--      panel-pool library (and its membership) is audit-worthy, same treatment
--      as comp_bands (0106) and every other tenant-editable config table.
-- Applied to BOTH panel_pools and panel_pool_members.
-- =====================================================================

ALTER TABLE public.panel_pools FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.panel_pool_members FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TRIGGER audit_panel_pools
AFTER INSERT OR UPDATE OR DELETE ON public.panel_pools
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_panel_pool_members
AFTER INSERT OR UPDATE OR DELETE ON public.panel_pool_members
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
