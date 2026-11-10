-- =====================================================================
-- 0127_interview_scheduling.sql — PC-8 / PC-9 / PC-10 (hand-written)
--
-- In-app interview scheduling, held entirely inside HireOps (no M365 /
-- Google calendar integration — that needs client IT and is out of the
-- PoC). Three NEW tables; NO existing table is altered, so code that does
-- not know about scheduling is unaffected by this migration.
--
--   panelist_availability_windows     NEW — weekly recurring windows
--   panelist_availability_exceptions  NEW — blocked / OOO / can't-attend ranges
--   interview_slot_offers             NEW — slots offered to a candidate
--
-- ─────────────────────────────────────────────────────────────────────
-- TIME MODEL
-- ─────────────────────────────────────────────────────────────────────
-- A weekly window is WALL-CLOCK in its own IANA zone (day_of_week 0 =
-- Sunday … 6 = Saturday, start/end in minutes after local midnight, end
-- may be 1440 = end of day). It is expanded to UTC instants per local date
-- by the slot engine, so "Mon 09:00–17:00 America/New_York" keeps meaning
-- 09:00 New York across a DST change. Exceptions and offered slots are
-- concrete instants (timestamptz, stored UTC).
--
-- ─────────────────────────────────────────────────────────────────────
-- "NEEDS RESCHEDULE" IS DERIVED, NOT STORED
-- ─────────────────────────────────────────────────────────────────────
-- A scheduled interview needs rescheduling when one of its CURRENT
-- panellists has an exception overlapping it. "Can't attend" writes such an
-- exception (kind = 'cannot_attend', interview_id = the round); an OOO range
-- added over an upcoming round does the same by overlap. Swapping the
-- panellist out clears the condition by construction — there is no flag to
-- forget to reset, and no new column on `interviews`.
--
-- ─────────────────────────────────────────────────────────────────────
-- interview_slot_offers
-- ─────────────────────────────────────────────────────────────────────
-- One row per "here are some times, pick one" sent to a candidate. `slots`
-- is a jsonb array of {start, end} UTC ISO strings. The candidate's signed
-- link (action `candidate.pick_interview_slot`, subject = the offer id) is
-- stored only as its SHA-256 (`token_hash`), exactly like the interview
-- confirm link. Status ladder: open → booked | expired | cancelled |
-- superseded. ONE open offer per (application, round) — enforced by a
-- partial unique so a second offer must supersede the first explicitly.
--
-- `replaces_interview_id` is set when the offer reschedules an existing
-- round (candidate asked, or a panellist can't attend); booking cancels
-- that round and creates the replacement in the same transaction.
-- `reason` records which of the three paths produced the offer; the
-- candidate's reschedule allowance is counted from it.
--
-- Booking is serialised by (1) SELECT … FOR UPDATE on the offer row and
-- (2) a transaction-scoped advisory lock per panellist, taken in sorted
-- order, after which the slot's freedom is re-checked against committed
-- interviews. Two picks of the same slot → exactly one books.
--
-- Conventions as 0119/0121: compound (tenant_id, …) FKs onto the
-- uniq_*_tenant_id_id constraints, tenant_isolation FOR ALL + FORCE ROW
-- LEVEL SECURITY, and an audit trigger on every table (availability decides
-- who is offered to a candidate; offers are candidate-facing state).
-- =====================================================================

CREATE TABLE "panelist_availability_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"day_of_week" smallint NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"timezone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_panelist_availability_windows_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "panelist_availability_windows_dow_check" CHECK ("day_of_week" BETWEEN 0 AND 6),
	CONSTRAINT "panelist_availability_windows_minutes_check"
		CHECK ("start_minute" >= 0 AND "start_minute" < 1440 AND "end_minute" > "start_minute" AND "end_minute" <= 1440),
	CONSTRAINT "panelist_availability_windows_timezone_check"
		CHECK (char_length("timezone") BETWEEN 1 AND 64)
);--> statement-breakpoint
ALTER TABLE "panelist_availability_windows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "panelist_availability_windows" ADD CONSTRAINT "panelist_availability_windows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panelist_availability_windows" ADD CONSTRAINT "fk_panelist_availability_windows_membership" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_panelist_availability_windows_membership" ON "panelist_availability_windows" USING btree ("tenant_id","membership_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "panelist_availability_windows" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
ALTER TABLE public.panelist_availability_windows FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER audit_panelist_availability_windows
AFTER INSERT OR UPDATE OR DELETE ON public.panelist_availability_windows
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TABLE "panelist_availability_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	-- 'blocked' (busy), 'out_of_office', or 'cannot_attend' (written by the
	-- "Can't attend" action against one interview).
	"kind" text DEFAULT 'blocked' NOT NULL,
	"reason" text,
	-- Set only for kind = 'cannot_attend': the round the panellist declined.
	-- SET NULL keeps the block if the interview row is ever deleted.
	"interview_id" uuid,
	"created_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_panelist_availability_exceptions_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "panelist_availability_exceptions_range_check" CHECK ("ends_at" > "starts_at"),
	CONSTRAINT "panelist_availability_exceptions_kind_check"
		CHECK ("kind" IN ('blocked', 'out_of_office', 'cannot_attend')),
	CONSTRAINT "panelist_availability_exceptions_reason_check"
		CHECK ("reason" IS NULL OR char_length("reason") <= 500)
);--> statement-breakpoint
ALTER TABLE "panelist_availability_exceptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "panelist_availability_exceptions" ADD CONSTRAINT "panelist_availability_exceptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panelist_availability_exceptions" ADD CONSTRAINT "fk_panelist_availability_exceptions_membership" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Single-column FK so ON DELETE SET NULL is legal (a compound SET NULL would
-- null tenant_id too — the notification_outbox reasoning).
ALTER TABLE "panelist_availability_exceptions" ADD CONSTRAINT "fk_panelist_availability_exceptions_interview" FOREIGN KEY ("interview_id") REFERENCES "public"."interviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_panelist_availability_exceptions_membership_range" ON "panelist_availability_exceptions" USING btree ("tenant_id","membership_id","ends_at");--> statement-breakpoint
CREATE INDEX "idx_panelist_availability_exceptions_interview" ON "panelist_availability_exceptions" USING btree ("tenant_id","interview_id") WHERE "interview_id" IS NOT NULL;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "panelist_availability_exceptions" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
ALTER TABLE public.panelist_availability_exceptions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER audit_panelist_availability_exceptions
AFTER INSERT OR UPDATE OR DELETE ON public.panelist_availability_exceptions
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TABLE "interview_slot_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"requisition_id" uuid NOT NULL,
	"round_number" integer NOT NULL,
	"round_name" text NOT NULL,
	"replaces_interview_id" uuid,
	"booked_interview_id" uuid,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"panel_membership_ids" uuid[] NOT NULL,
	"lead_membership_id" uuid,
	"duration_minutes" integer NOT NULL,
	"mode" text NOT NULL,
	"meeting_url" text,
	"slots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"timezone" text NOT NULL,
	"token_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"booked_slot_start" timestamp with time zone,
	"booked_at" timestamp with time zone,
	"booked_via" text,
	"created_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_interview_slot_offers_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "interview_slot_offers_status_check"
		CHECK ("status" IN ('open', 'booked', 'expired', 'cancelled', 'superseded')),
	CONSTRAINT "interview_slot_offers_reason_check"
		CHECK ("reason" IN ('initial', 'candidate_reschedule', 'panelist_unavailable', 'recruiter_reschedule')),
	CONSTRAINT "interview_slot_offers_booked_via_check"
		CHECK ("booked_via" IS NULL OR "booked_via" IN ('candidate_link', 'candidate_portal')),
	CONSTRAINT "interview_slot_offers_mode_check" CHECK ("mode" IN ('video', 'onsite', 'phone')),
	CONSTRAINT "interview_slot_offers_duration_check" CHECK ("duration_minutes" BETWEEN 15 AND 480),
	CONSTRAINT "interview_slot_offers_slots_array_check" CHECK (jsonb_typeof("slots") = 'array'),
	CONSTRAINT "interview_slot_offers_panel_check" CHECK (cardinality("panel_membership_ids") >= 1)
);--> statement-breakpoint
ALTER TABLE "interview_slot_offers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "interview_slot_offers" ADD CONSTRAINT "interview_slot_offers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_slot_offers" ADD CONSTRAINT "fk_interview_slot_offers_application" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_slot_offers" ADD CONSTRAINT "fk_interview_slot_offers_requisition" FOREIGN KEY ("tenant_id","requisition_id") REFERENCES "public"."requisitions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_slot_offers" ADD CONSTRAINT "fk_interview_slot_offers_created_by" FOREIGN KEY ("tenant_id","created_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_slot_offers" ADD CONSTRAINT "fk_interview_slot_offers_replaces" FOREIGN KEY ("replaces_interview_id") REFERENCES "public"."interviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_slot_offers" ADD CONSTRAINT "fk_interview_slot_offers_booked" FOREIGN KEY ("booked_interview_id") REFERENCES "public"."interviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- ONE open offer per (application, round).
CREATE UNIQUE INDEX "uniq_interview_slot_offers_open_round" ON "interview_slot_offers" USING btree ("tenant_id","application_id","round_number") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "idx_interview_slot_offers_application" ON "interview_slot_offers" USING btree ("tenant_id","application_id");--> statement-breakpoint
CREATE INDEX "idx_interview_slot_offers_token_hash" ON "interview_slot_offers" USING btree ("token_hash") WHERE "token_hash" IS NOT NULL;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "interview_slot_offers" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
ALTER TABLE public.interview_slot_offers FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER audit_interview_slot_offers
AFTER INSERT OR UPDATE OR DELETE ON public.interview_slot_offers
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
