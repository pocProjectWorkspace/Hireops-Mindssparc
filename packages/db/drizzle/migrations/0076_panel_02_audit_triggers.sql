-- =====================================================================
-- 0076_panel_02_audit_triggers.sql — PANEL-02 (hand-written)
--
-- Attach audit_record_change() to the PANEL-02 tenant-scoped table.
-- interview_prep is a regenerable real-AI cache whose replacement is worth an
-- audit row — same treatment as requisition_feasibility (0064) and
-- comp_recommendations (0070): every tenant-scoped mutable domain table gets
-- the trigger.
-- =====================================================================

CREATE TRIGGER audit_interview_prep
AFTER INSERT OR UPDATE OR DELETE ON public.interview_prep
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
