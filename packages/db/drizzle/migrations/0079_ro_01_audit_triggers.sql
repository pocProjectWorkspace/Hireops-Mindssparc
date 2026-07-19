-- =====================================================================
-- 0079_ro_01_audit_triggers.sql — RO-01 (hand-written)
--
-- Attach audit_record_change() to req_revision_suggestions. A regenerable
-- AI artifact whose replacement is worth an audit row — same treatment as
-- requisition_feasibility (0064) and comp_recommendations (0070). Every
-- tenant-scoped mutable domain table gets the trigger.
-- =====================================================================

CREATE TRIGGER audit_req_revision_suggestions
AFTER INSERT OR UPDATE OR DELETE ON public.req_revision_suggestions
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
