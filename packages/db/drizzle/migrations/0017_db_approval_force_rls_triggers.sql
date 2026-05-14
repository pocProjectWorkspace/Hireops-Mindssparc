-- =====================================================================
-- 0017_db_approval_force_rls_triggers.sql — DB-APPROVAL (hand-written)
--
-- Companion to 0016_skinny_jack_power.sql. Drizzle's pgPolicy +
-- .enableRLS() emit ENABLE ROW LEVEL SECURITY but not FORCE; FND-15c's
-- lint-rls requires both. The four DB-APPROVAL tables get FORCE here,
-- and the DB-AUDIT trigger is attached to matrices / chains / requests.
--
-- approval_decisions is intentionally NOT audited — it is itself the
-- audit trail for the approval chain's progression. Same exclusion
-- that exists for requisition_state_transitions and
-- application_state_transitions.
-- =====================================================================

ALTER TABLE public.approval_matrices FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.approval_chains FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.approval_requests FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.approval_decisions FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TRIGGER audit_approval_matrices
AFTER INSERT OR UPDATE OR DELETE ON public.approval_matrices
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_approval_chains
AFTER INSERT OR UPDATE OR DELETE ON public.approval_chains
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_approval_requests
AFTER INSERT OR UPDATE OR DELETE ON public.approval_requests
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
