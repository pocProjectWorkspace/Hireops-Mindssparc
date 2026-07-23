-- =====================================================================
-- 0103_t22_force_rls_audit.sql — T2.2 / G07 (hand-written)
--
-- Companion to 0100/0101. Two things every tenant-scoped config table gets,
-- folded into one migration (the 0099/0097/0092 precedent):
--   1. FORCE ROW LEVEL SECURITY — drizzle's .enableRLS() emits ENABLE but never
--      FORCE; lint-rls (FND-15c) requires both.
--   2. audit_record_change() trigger — an admin edit to the tenant round loop
--      or a custom scorecard rubric is audit-worthy, same treatment as
--      market_benchmarks (0064), candidate_field_policy (0099), and every other
--      tenant-editable config table.
-- =====================================================================

ALTER TABLE public.tenant_interview_round_template FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.tenant_scorecard_template FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TRIGGER audit_tenant_interview_round_template
AFTER INSERT OR UPDATE OR DELETE ON public.tenant_interview_round_template
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_tenant_scorecard_template
AFTER INSERT OR UPDATE OR DELETE ON public.tenant_scorecard_template
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
