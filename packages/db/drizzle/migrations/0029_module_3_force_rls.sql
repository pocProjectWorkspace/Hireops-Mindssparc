-- =====================================================================
-- 0029_module_3_force_rls.sql — Module 3 notifications (hand-written)
--
-- Companion to 0028_overjoyed_naoko.sql. Drizzle's pgPolicy +
-- .enableRLS() emit ENABLE ROW LEVEL SECURITY but not FORCE; FND-15c's
-- lint-rls requires both.
-- =====================================================================

ALTER TABLE public.notification_outbox FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.dev_email_outbox FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.signed_link_uses FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.scheduled_job_runs FORCE ROW LEVEL SECURITY;
