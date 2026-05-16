-- =====================================================================
-- 0031_module_3_relax_fks.sql — Module 3 hot-fix (hand-written)
--
-- 0028 created compound FKs on notification_outbox + dev_email_outbox:
--   notification_outbox (tenant_id, recipient_membership_id) → tenant_user_memberships(tenant_id, id) ON DELETE SET NULL
--   notification_outbox (tenant_id, recipient_candidate_id)  → candidates(tenant_id, id)              ON DELETE SET NULL
--   dev_email_outbox    (tenant_id, outbox_id)               → notification_outbox(tenant_id, id)    ON DELETE SET NULL
--
-- Postgres rejects the SET NULL when those compound FKs fire — it nulls
-- EVERY referenced column, including tenant_id (NOT NULL), so deleting
-- a referenced parent row blows up with 23502.
--
-- Fix: drop the compound FKs and re-add as plain single-column FKs on
-- .id. Tenant integrity is still enforced via the row's own
-- (tenant_id → tenants.id) FK plus the tenant_isolation policy; the
-- worker reads the row's denormalised tenant_id and never joins via
-- the recipient pointer.
-- =====================================================================

ALTER TABLE public.notification_outbox
  DROP CONSTRAINT IF EXISTS fk_notification_outbox_membership;--> statement-breakpoint
ALTER TABLE public.notification_outbox
  DROP CONSTRAINT IF EXISTS fk_notification_outbox_candidate;--> statement-breakpoint
ALTER TABLE public.dev_email_outbox
  DROP CONSTRAINT IF EXISTS fk_dev_email_outbox_outbox;--> statement-breakpoint

ALTER TABLE public.notification_outbox
  ADD CONSTRAINT notification_outbox_recipient_membership_id_fkey
  FOREIGN KEY (recipient_membership_id)
  REFERENCES public.tenant_user_memberships(id)
  ON DELETE SET NULL;--> statement-breakpoint

ALTER TABLE public.notification_outbox
  ADD CONSTRAINT notification_outbox_recipient_candidate_id_fkey
  FOREIGN KEY (recipient_candidate_id)
  REFERENCES public.candidates(id)
  ON DELETE SET NULL;--> statement-breakpoint

ALTER TABLE public.dev_email_outbox
  ADD CONSTRAINT dev_email_outbox_outbox_id_fkey
  FOREIGN KEY (outbox_id)
  REFERENCES public.notification_outbox(id)
  ON DELETE SET NULL;
