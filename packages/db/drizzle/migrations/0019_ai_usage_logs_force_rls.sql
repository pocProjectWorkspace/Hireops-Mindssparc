-- =====================================================================
-- 0019_ai_usage_logs_force_rls.sql — AI-01 (hand-written)
--
-- Companion to 0018_complex_squirrel_girl.sql. Drizzle's pgPolicy +
-- .enableRLS() emit ENABLE ROW LEVEL SECURITY but not FORCE; FND-15c's
-- lint-rls requires both.
--
-- ai_usage_logs is intentionally NOT audited — it IS the log. Attaching
-- audit_record_change to it would produce a 1:1 noise stream. Same
-- exclusion that applies to requisition_state_transitions,
-- application_state_transitions, and approval_decisions.
-- =====================================================================

ALTER TABLE public.ai_usage_logs FORCE ROW LEVEL SECURITY;
