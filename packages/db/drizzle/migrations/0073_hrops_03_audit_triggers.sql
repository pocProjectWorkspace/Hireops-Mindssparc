-- =====================================================================
-- 0067_hrops_03_audit_triggers.sql — HROPS-03 (hand-written)
--
-- Attach audit_record_change() to the HROPS-03 tenant-scoped mutable tables.
--
--   application_documents — every request / upload / verify / reject is an
--     audit-worthy state change; the trigger rows feed the /case-audit
--     "document events" timeline.
--   hr_case_notes         — an insert is the audit event itself: the trigger
--     writes the audit_logs row the /case-audit timeline renders as a note.
--
-- hr_policy_documents is deliberately NOT triggered: it is curated reference
-- content seeded via db:seed:hr-policies (an idempotent upsert re-run each
-- groom), so trigger rows would be seed noise, not governance signal. It keeps
-- FORCE RLS + tenant isolation; it just isn't row-change-audited (same stance
-- as the reference-style tables that skip the trigger).
-- =====================================================================

CREATE TRIGGER audit_application_documents
AFTER INSERT OR UPDATE OR DELETE ON public.application_documents
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_hr_case_notes
AFTER INSERT OR UPDATE OR DELETE ON public.hr_case_notes
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
