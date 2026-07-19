-- =====================================================================
-- 0090_cand_02_notification_read_state.sql — CAND-02 (hand-written)
--
-- The candidate Notifications feed (/candidate/notifications) surfaces the
-- REAL candidate-directed rows already written to notification_outbox
-- (recipient_type = 'candidate': interview_invitation, stage_advanced,
-- offer_extended, account_activation, agent_message, …). No notifications are
-- fabricated — the feed is a person-scoped read of that outbox.
--
-- This migration adds honest, persisted read-state so "Mark all read" means
-- something:
--   candidate_read_at  timestamptz  NULL — when the candidate marked this row
--     read (NULL = unread). Set only by candidateMarkNotificationsRead, which
--     is person-scoped (recipient_candidate_id = the caller's candidate row).
--     Each candidate-directed row has exactly one candidate recipient, so a
--     single column on the row is the correct grain — no separate reads table.
--
-- Plus a partial index for the feed's person-scoped lookup + newest-first sort.
--
-- Additive + NULLABLE: the delivery worker (apps/workers) never reads this
-- column, and every existing row / internal insert path is valid unchanged.
-- notification_outbox already carries tenant_isolation + its audit trigger;
-- ADD COLUMN does not disturb either.
--
-- NOTE (parallel-ticket coordination): CAND-02 reserves 0089–0091; renumber at
-- reconciliation if a sibling ticket also lands migrations. ALTERs
-- notification_outbox only (no new table).
-- =====================================================================

ALTER TABLE "notification_outbox" ADD COLUMN IF NOT EXISTS "candidate_read_at" timestamptz;

CREATE INDEX IF NOT EXISTS "idx_notification_outbox_candidate_feed"
  ON "notification_outbox" ("tenant_id", "recipient_candidate_id", "created_at")
  WHERE "recipient_candidate_id" IS NOT NULL;
