-- =====================================================================
-- 0053_int_01_audit_triggers.sql — INT-01 (hand-written)
--
-- Attach audit_record_change() to every tenant-scoped interview table.
-- These are mutable domain tables (interview scheduling, panel
-- membership, scorecard/feedback lifecycle) whose changes are
-- audit-worthy and DPDPA-relevant — same treatment as
-- offers/applications/onboarding_*.
-- =====================================================================

CREATE TRIGGER audit_interview_plans
AFTER INSERT OR UPDATE OR DELETE ON public.interview_plans
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_interviews
AFTER INSERT OR UPDATE OR DELETE ON public.interviews
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_interview_panelists
AFTER INSERT OR UPDATE OR DELETE ON public.interview_panelists
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_interview_feedback
AFTER INSERT OR UPDATE OR DELETE ON public.interview_feedback
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
