-- =====================================================================
-- 0067_hrops_02_audit_triggers.sql — HROPS-02 (hand-written)
--
-- Attach audit_record_change() to comp_recommendations. A regenerable AI
-- rationale whose replacement is worth an audit row — same treatment as
-- requisition_feasibility (0064). Every tenant-scoped mutable domain table
-- gets the trigger.
-- =====================================================================

CREATE TRIGGER audit_comp_recommendations
AFTER INSERT OR UPDATE OR DELETE ON public.comp_recommendations
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
