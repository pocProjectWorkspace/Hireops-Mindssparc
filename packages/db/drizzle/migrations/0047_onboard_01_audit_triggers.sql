-- =====================================================================
-- 0047_onboard_01_audit_triggers.sql — ONBOARD-01 (hand-written)
--
-- Attach audit_record_change() to every tenant-scoped onboarding table.
-- These are mutable domain tables (case/task/document lifecycle, BGV +
-- provisioning + asset state transitions) whose changes are audit-worthy
-- and DPDPA-relevant — same treatment as offers/applications.
--
-- document_types is intentionally EXCLUDED: it is the tenant-agnostic
-- reference table with NO tenant_id, and audit_record_change() RAISEs on
-- a NULL tenant_id by design (it attaches only to tenant-scoped tables).
-- =====================================================================

CREATE TRIGGER audit_onboarding_cases
AFTER INSERT OR UPDATE OR DELETE ON public.onboarding_cases
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_onboarding_tasks
AFTER INSERT OR UPDATE OR DELETE ON public.onboarding_tasks
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_onboarding_documents
AFTER INSERT OR UPDATE OR DELETE ON public.onboarding_documents
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_bgv_runs
AFTER INSERT OR UPDATE OR DELETE ON public.bgv_runs
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_bgv_results
AFTER INSERT OR UPDATE OR DELETE ON public.bgv_results
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_it_provisioning_requests
AFTER INSERT OR UPDATE OR DELETE ON public.it_provisioning_requests
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_asset_assignments
AFTER INSERT OR UPDATE OR DELETE ON public.asset_assignments
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
