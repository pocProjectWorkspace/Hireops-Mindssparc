-- =====================================================================
-- 0110_iris_assistant_actions_force_rls.sql — IRIS-A1 (hand-written)
--
-- Companion to 0109_iris_assistant_actions.sql. Drizzle's pgPolicy +
-- .enableRLS() emit ENABLE ROW LEVEL SECURITY but not FORCE; FND-15c's
-- lint-rls requires both. Same pairing as 0020/0021 (api_audit_logs) and
-- 0043/0044 (pii_access_log).
--
-- assistant_actions is intentionally NOT audited by the audit_record_change
-- trigger — it IS a log of assistant-executed actions. Attaching the trigger
-- would create a 1:1 noise stream (same exclusion as api_audit_logs /
-- ai_usage_logs / pii_access_log / the *_state_transitions tables).
-- =====================================================================

ALTER TABLE public.assistant_actions FORCE ROW LEVEL SECURITY;
