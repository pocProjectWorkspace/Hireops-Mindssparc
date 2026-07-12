-- =====================================================================
-- 0044_pii_access_log_force_rls.sql — PII-01 (hand-written)
--
-- Companion to 0043_pii_access_log.sql. Drizzle's pgPolicy + .enableRLS()
-- emit ENABLE ROW LEVEL SECURITY but not FORCE; FND-15c's lint-rls requires
-- both. Same pairing as 0020/0021 for api_audit_logs.
--
-- pii_access_log is intentionally NOT audited by the audit_record_change
-- trigger — it IS the PII-access audit log. Attaching the trigger would
-- create a 1:1 noise stream (same exclusion as api_audit_logs /
-- ai_usage_logs / the *_state_transitions tables).
-- =====================================================================

ALTER TABLE public.pii_access_log FORCE ROW LEVEL SECURITY;
