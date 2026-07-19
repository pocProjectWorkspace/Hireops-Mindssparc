-- =====================================================================
-- 0067_hrops_01_audit_triggers.sql — HROPS-01 (hand-written)
--
-- Attach audit_record_change() to the HROPS-01 tenant-scoped table.
-- hr_round_assessments is human-completed HR judgement whose save/edit is a
-- deliberate, audit-worthy action (it also gates the offer-stage advance).
-- Same treatment as offers / onboarding / offboarding / market_benchmarks —
-- every tenant-scoped mutable domain table gets the trigger.
-- =====================================================================

CREATE TRIGGER audit_hr_round_assessments
AFTER INSERT OR UPDATE OR DELETE ON public.hr_round_assessments
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
