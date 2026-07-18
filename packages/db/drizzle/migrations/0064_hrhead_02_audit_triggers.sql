-- =====================================================================
-- 0064_hrhead_02_audit_triggers.sql — HRHEAD-02 (hand-written)
--
-- Attach audit_record_change() to both HRHEAD-02 tenant-scoped tables.
-- market_benchmarks is admin-editable curated reference data (an edit is a
-- deliberate, audit-worthy governance action); requisition_feasibility is a
-- regenerable AI assessment whose replacement is worth an audit row. Same
-- treatment as offers / onboarding / offboarding — every tenant-scoped
-- mutable domain table gets the trigger.
-- =====================================================================

CREATE TRIGGER audit_market_benchmarks
AFTER INSERT OR UPDATE OR DELETE ON public.market_benchmarks
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_requisition_feasibility
AFTER INSERT OR UPDATE OR DELETE ON public.requisition_feasibility
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
