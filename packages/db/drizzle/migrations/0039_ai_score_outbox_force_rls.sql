-- =====================================================================
-- 0039_ai_score_outbox_force_rls.sql — AI-03 (hand-written companion).
--
-- Drizzle's pgPolicy + .enableRLS() emit ENABLE ROW LEVEL SECURITY but
-- not FORCE; FND-15c's lint-rls requires both. Same pattern as
-- 0034_module_4_force_rls.sql.
--
-- No audit trigger attached: ai_score_outbox IS the log of scoring
-- attempts (same exclusion as notification_outbox / workday_sync_outbox
-- / ai_usage_logs / *_state_transitions). The applications table
-- carries the consumer-facing fields (ai_score, ai_score_explanation,
-- ai_scored_at) and already has audit triggers attached.
-- =====================================================================

ALTER TABLE public.ai_score_outbox FORCE ROW LEVEL SECURITY;
