-- =====================================================================
-- 0030_module_3_audit_triggers.sql — Module 3 notifications (hand-written)
--
-- Attaches audit_record_change() to notification_outbox only. The
-- other three Module-3 tables are intentionally excluded:
--   - dev_email_outbox — dev-only log mirror; same exclusion pattern as
--     ai_usage_logs / api_audit_logs / partner_candidate_messages
--   - signed_link_uses — IS the redemption audit log (split RLS,
--     append-only at the policy level)
--   - scheduled_job_runs — platform-level worker bookkeeping; not
--     tenant-scoped, not user-facing
-- =====================================================================

CREATE TRIGGER audit_notification_outbox
AFTER INSERT OR UPDATE OR DELETE ON public.notification_outbox
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
