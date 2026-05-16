-- =====================================================================
-- 0023_db_partner_a_force_rls.sql — DB-PARTNER-A (hand-written)
--
-- Companion to 0022_organic_warlock.sql. Drizzle's pgPolicy +
-- .enableRLS() emit ENABLE ROW LEVEL SECURITY but not FORCE; FND-15c's
-- lint-rls requires both.
-- =====================================================================

ALTER TABLE public.partner_orgs FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.partner_users FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.partner_invitations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.partner_assignments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.candidate_ownership_claims FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.candidate_dedup_attempts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.partner_candidate_messages FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.ad_hoc_partner_domains FORCE ROW LEVEL SECURITY;
