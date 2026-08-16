-- =====================================================================
-- 0115_interview_lifecycle_timestamps.sql — R1.2 (hand-written)
--
-- interviews.completed_at / cancelled_at. The status column said WHAT,
-- never WHEN — the reporting assessment (build plan §2.3) pinned this as
-- the gap blocking interview-health cycle times. The api sets these on
-- status transitions from 0115 onward; existing rows are backfilled with
-- the best available approximation and reports know it is one:
--   completed → COALESCE(scheduled_end, updated_at)
--   cancelled → updated_at
-- =====================================================================

ALTER TABLE "interviews" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint

UPDATE "interviews" SET "completed_at" = COALESCE("scheduled_end", "updated_at")
WHERE "status" = 'completed' AND "completed_at" IS NULL;--> statement-breakpoint

UPDATE "interviews" SET "cancelled_at" = "updated_at"
WHERE "status" = 'cancelled' AND "cancelled_at" IS NULL;
