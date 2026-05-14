-- =====================================================================
-- 0015_db03_force_rls_triggers.sql — DB-03 (hand-written)
--
-- Companion to 0014_married_doctor_faustus.sql. Drizzle's pgPolicy +
-- .enableRLS() emit ENABLE ROW LEVEL SECURITY but not FORCE; FND-15c's
-- lint-rls requires both. The four DB-03 tables get FORCE here, and the
-- DB-AUDIT trigger is attached to persons / candidates / applications.
--
-- application_state_transitions is intentionally NOT audited — it is
-- itself the audit trail for stage changes; auditing its inserts would
-- duplicate the story (same exclusion as requisition_state_transitions).
-- =====================================================================

ALTER TABLE public.persons FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.candidates FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.applications FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.application_state_transitions FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TRIGGER audit_persons
AFTER INSERT OR UPDATE OR DELETE ON public.persons
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_candidates
AFTER INSERT OR UPDATE OR DELETE ON public.candidates
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_applications
AFTER INSERT OR UPDATE OR DELETE ON public.applications
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
