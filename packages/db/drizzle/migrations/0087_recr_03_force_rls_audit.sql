-- =====================================================================
-- 0087_recr_03_force_rls_audit.sql — RECR-03 (hand-written)
--
-- Companion to 0085/0086. Drizzle's .enableRLS() emits ENABLE ROW LEVEL
-- SECURITY but never FORCE; lint-rls (FND-15c) requires both on every
-- tenant-scoped table. And every tenant-scoped mutable domain table gets the
-- audit_record_change() trigger (same treatment as interview_prep 0074/0075/
-- 0076 and req_revision_suggestions 0077/0078/0079).
--
-- Both tables are tenant-scoped: missing_info_requests is a mutable lifecycle
-- record (worth auditing state changes); recruiter_brief is regenerable AI data
-- whose replacement is worth an audit row.
-- =====================================================================

ALTER TABLE public.missing_info_requests FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.recruiter_brief FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TRIGGER audit_missing_info_requests
AFTER INSERT OR UPDATE OR DELETE ON public.missing_info_requests
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_recruiter_brief
AFTER INSERT OR UPDATE OR DELETE ON public.recruiter_brief
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
