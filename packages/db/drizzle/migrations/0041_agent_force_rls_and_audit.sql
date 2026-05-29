-- =====================================================================
-- 0041_agent_force_rls_and_audit.sql — AGENT-01b (hand-written)
--
-- Companion to 0040_familiar_zarda.sql (AGENT-01a).
--
-- Part A — FORCE ROW LEVEL SECURITY on the 9 new agent tables. Drizzle's
-- pgPolicy + .enableRLS() emit ENABLE ROW LEVEL SECURITY but not FORCE;
-- FND-15c's lint-rls requires both so BYPASSRLS roles don't skip policies.
-- Same companion-migration pattern as 0026_db_partner_a_force_rls.sql.
--
-- Part B — audit_record_change() trigger on the 5 Category A tables only
-- (business state worth auditing per row). Category B tables (agent_runs,
-- agent_run_actions, agent_run_outbox, candidate_inbound_messages) are
-- intentionally excluded — they are high-volume operational data and a
-- trigger per row would balloon audit_logs without proportional audit
-- value. Same exclusion pattern as notification_outbox, ai_usage_logs,
-- api_audit_logs, and the *_state_transitions tables.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Part A — FORCE RLS
-- ---------------------------------------------------------------------

ALTER TABLE public.automation_agents FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.agent_triggers FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.agent_actions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.agent_approval_rules FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.agent_runs FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.agent_run_actions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.agent_approval_requests FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.agent_run_outbox FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.candidate_inbound_messages FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- ---------------------------------------------------------------------
-- Part B — audit triggers on Category A (5 tables)
-- ---------------------------------------------------------------------

CREATE TRIGGER audit_automation_agents
AFTER INSERT OR UPDATE OR DELETE ON public.automation_agents
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_agent_triggers
AFTER INSERT OR UPDATE OR DELETE ON public.agent_triggers
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_agent_actions
AFTER INSERT OR UPDATE OR DELETE ON public.agent_actions
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_agent_approval_rules
AFTER INSERT OR UPDATE OR DELETE ON public.agent_approval_rules
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_agent_approval_requests
AFTER INSERT OR UPDATE OR DELETE ON public.agent_approval_requests
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
