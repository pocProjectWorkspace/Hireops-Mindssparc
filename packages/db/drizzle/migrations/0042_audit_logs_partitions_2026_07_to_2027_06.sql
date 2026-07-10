-- =====================================================================
-- 0042 — audit_logs monthly partitions, 2026-07 through 2027-06.
--
-- WHY THIS IS URGENT, NOT ROUTINE
-- ------------------------------------------------------------------
-- Migration 0012 created exactly two partitions (2026_05, 2026_06) with
-- the note: "DB-AUDIT-RETENTION will own ongoing partition rotation ...
-- Until then partitions are pre-created by hand in migrations."
--
-- DB-AUDIT-RETENTION was never written. `audit_logs` has no DEFAULT
-- partition, so from 2026-07-01 every INSERT routed to no partition and
-- raised:
--
--     no partition of relation "audit_logs" found for row
--
-- `audit_record_change()` fires on INSERT/UPDATE/DELETE of every audited
-- domain table, inside the caller's transaction. So since 2026-07-01
-- EVERY audited mutation has been failing outright — creating an agent,
-- resolving an approval, submitting an application, drafting an offer.
-- This was found on 2026-07-10 when the agent test suite began failing
-- on a code path that had nothing to do with auditing.
--
-- WHY NO DEFAULT PARTITION
-- ------------------------------------------------------------------
-- A DEFAULT partition would have converted this hard failure into a
-- silent one: rows would land in the catch-all and the miss would go
-- unnoticed until someone queried by month. It also makes every future
-- ATTACH scan the default partition for conflicting rows. Loud failure
-- was the right default; the bug is that nothing created the next month.
--
-- WHAT THIS FIXES AND WHAT IT DOES NOT
-- ------------------------------------------------------------------
-- Fixes: twelve months of runway, through 2027-06-30.
-- Does NOT fix: the absence of automated rotation. On 2027-07-01 this
-- breaks again in exactly the same way. The durable fix is a scheduled
-- worker job that pre-creates next-next month's partition and drops
-- partitions past the retention window. Tracked in open-questions.md.
--
-- FORCE ROW LEVEL SECURITY is applied per partition, mirroring 0013.
-- `lint-rls.ts` skips partition children (relispartition = true) because
-- they inherit the parent's policies when queried through the parent;
-- the explicit FORCE here defends the direct-access path.
-- =====================================================================

CREATE TABLE IF NOT EXISTS "audit_logs_2026_07" PARTITION OF "audit_logs"
	FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs_2026_08" PARTITION OF "audit_logs"
	FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs_2026_09" PARTITION OF "audit_logs"
	FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs_2026_10" PARTITION OF "audit_logs"
	FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs_2026_11" PARTITION OF "audit_logs"
	FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs_2026_12" PARTITION OF "audit_logs"
	FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs_2027_01" PARTITION OF "audit_logs"
	FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs_2027_02" PARTITION OF "audit_logs"
	FOR VALUES FROM ('2027-02-01 00:00:00+00') TO ('2027-03-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs_2027_03" PARTITION OF "audit_logs"
	FOR VALUES FROM ('2027-03-01 00:00:00+00') TO ('2027-04-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs_2027_04" PARTITION OF "audit_logs"
	FOR VALUES FROM ('2027-04-01 00:00:00+00') TO ('2027-05-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs_2027_05" PARTITION OF "audit_logs"
	FOR VALUES FROM ('2027-05-01 00:00:00+00') TO ('2027-06-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs_2027_06" PARTITION OF "audit_logs"
	FOR VALUES FROM ('2027-06-01 00:00:00+00') TO ('2027-07-01 00:00:00+00');--> statement-breakpoint

ALTER TABLE public.audit_logs_2026_07 FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.audit_logs_2026_08 FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.audit_logs_2026_09 FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.audit_logs_2026_10 FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.audit_logs_2026_11 FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.audit_logs_2026_12 FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.audit_logs_2027_01 FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.audit_logs_2027_02 FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.audit_logs_2027_03 FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.audit_logs_2027_04 FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.audit_logs_2027_05 FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.audit_logs_2027_06 FORCE ROW LEVEL SECURITY;
