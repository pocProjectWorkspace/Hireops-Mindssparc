-- =====================================================================
-- 0061_offboard_01_audit_triggers.sql — OFFBOARD-01 (hand-written)
--
-- Attach audit_record_change() to every tenant-scoped offboarding table.
-- These are mutable domain tables (case/task lifecycle, exit-interview
-- capture, asset-return sign-off, F&F settlement state) whose changes are
-- audit-worthy and DPDPA-relevant — same treatment as onboarding /
-- offers / applications. All five are tenant-scoped, so all five get the
-- trigger (no reference table to exclude, unlike ONBOARD-01's document_types).
-- =====================================================================

CREATE TRIGGER audit_offboarding_cases
AFTER INSERT OR UPDATE OR DELETE ON public.offboarding_cases
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_offboarding_tasks
AFTER INSERT OR UPDATE OR DELETE ON public.offboarding_tasks
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_exit_interviews
AFTER INSERT OR UPDATE OR DELETE ON public.exit_interviews
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_asset_returns
AFTER INSERT OR UPDATE OR DELETE ON public.asset_returns
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_final_settlements
AFTER INSERT OR UPDATE OR DELETE ON public.final_settlements
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
