-- =====================================================================
-- 0058_cand_01_audit_triggers.sql — CAND-01 (hand-written)
--
-- Attach audit_record_change() to candidate_accounts. It is a mutable
-- identity table (activation, status flips, last-login) whose changes are
-- audit-worthy and DPDPA-relevant — same treatment as partner_users and
-- the interview tables (0053).
-- =====================================================================

CREATE TRIGGER audit_candidate_accounts
AFTER INSERT OR UPDATE OR DELETE ON public.candidate_accounts
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
