-- =====================================================================
-- 0024_db_partner_a_audit_triggers.sql — DB-PARTNER-A (hand-written)
--
-- Attaches the audit_record_change() trigger to the 6 mutable partner
-- tables. The two log-shaped tables are intentionally excluded:
--   - candidate_dedup_attempts — IS the dedup audit log (split RLS,
--     append-only at the policy level)
--   - partner_candidate_messages — conceptually a message log even
--     though delivery_status is mutable (see schema-file comment).
-- Same exclusion pattern as ai_usage_logs, api_audit_logs, and the
-- *_state_transitions tables.
-- =====================================================================

CREATE TRIGGER audit_partner_orgs
AFTER INSERT OR UPDATE OR DELETE ON public.partner_orgs
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_partner_users
AFTER INSERT OR UPDATE OR DELETE ON public.partner_users
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_partner_invitations
AFTER INSERT OR UPDATE OR DELETE ON public.partner_invitations
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_partner_assignments
AFTER INSERT OR UPDATE OR DELETE ON public.partner_assignments
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_candidate_ownership_claims
AFTER INSERT OR UPDATE OR DELETE ON public.candidate_ownership_claims
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_ad_hoc_partner_domains
AFTER INSERT OR UPDATE OR DELETE ON public.ad_hoc_partner_domains
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
