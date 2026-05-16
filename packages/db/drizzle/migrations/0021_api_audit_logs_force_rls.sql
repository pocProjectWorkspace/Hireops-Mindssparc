-- =====================================================================
-- 0021_api_audit_logs_force_rls.sql — API-01 (hand-written)
--
-- Companion to 0020_hard_felicia_hardy.sql. Drizzle's pgPolicy +
-- .enableRLS() emit ENABLE ROW LEVEL SECURITY but not FORCE; FND-15c's
-- lint-rls requires both.
--
-- api_audit_logs is intentionally NOT audited by the audit_record_change
-- trigger — it IS the API-layer audit log. Attaching the trigger would
-- create a 1:1 noise stream. Same exclusion as ai_usage_logs and the
-- *_state_transitions tables.
-- =====================================================================

ALTER TABLE public.api_audit_logs FORCE ROW LEVEL SECURITY;
