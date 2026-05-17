-- =====================================================================
-- 0035_module_4_audit_triggers.sql — Module 4 (hand-written)
--
-- Attach audit_record_change() to `offers` only. `workday_sync_outbox`
-- is intentionally excluded for the same reason notification_outbox /
-- ai_usage_logs / api_audit_logs / partner_candidate_messages are:
-- it IS the log of external syncs, not application state.
-- =====================================================================

CREATE TRIGGER audit_offers
AFTER INSERT OR UPDATE OR DELETE ON public.offers
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
