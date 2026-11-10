-- =====================================================================
-- 0128_pre_joining_engagement.sql — PC-14..17 (hand-written)
--
-- Notice-period candidate engagement: scheduled check-ins and pulses
-- between offer accept and joining, reply risk signals, the joining-risk
-- watchlist, and renege capture.
--
--   pre_joining_journeys          NEW — one per accepted application
--   pre_joining_company_updates   NEW — tenant-authored content items
--   pre_joining_touchpoints       NEW — the scheduled sends (drain queue)
--   pre_joining_pulse_responses   NEW — "still on track?" answers
--   candidate_risk_signals        NEW — named things a candidate SAID
--   offer_reneges                 NEW — accepted → reneged, with reason
--   candidate_inbound_messages    +journey_id, +classification_* columns
--
-- Settings live in tenants.settings.preJoiningEngagement (no table) —
-- platform default disabled; see packages/api-types/src/pre-joining-engagement.ts.
--
-- ─────────────────────────────────────────────────────────────────────
-- FACTS, NOT SCORES
-- ─────────────────────────────────────────────────────────────────────
-- candidate_risk_signals holds a NAMED signal from a fixed platform list
-- plus the candidate's own words (a verbatim quote, verified against the
-- message before insert) or their pulse answer. There is NO flight-risk
-- score, probability, rating or ranking column anywhere in this
-- migration, and there must never be one (CLAUDE.md "Product stances").
-- A future ticket must not read the omission as a gap to fill.
--
-- Conventions: compound (tenant_id, x) FKs onto uniq_*_tenant_id_id,
-- tenant_isolation policy + FORCE ROW LEVEL SECURITY on every table,
-- audit trigger on governed state (journeys, signals, reneges, company
-- updates). Touchpoints / pulse responses are high-volume operational
-- rows and are not audited (their state is visible on the timeline).
-- =====================================================================

-- ── pre_joining_journeys ────────────────────────────────────────────
CREATE TABLE "pre_joining_journeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"joining_date" date NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"stop_reason" text,
	-- Routing token for replies: replies+<token>@<inbound domain>. Not a
	-- credential (the webhook itself is signature-verified); it only says
	-- which journey a reply belongs to.
	"reply_token" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_pre_joining_journeys_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_pre_joining_journeys_application" UNIQUE("tenant_id","application_id"),
	CONSTRAINT "uniq_pre_joining_journeys_reply_token" UNIQUE("reply_token"),
	CONSTRAINT "pre_joining_journeys_status_check" CHECK ("status" IN ('active', 'stopped', 'completed')),
	CONSTRAINT "pre_joining_journeys_stop_reason_check" CHECK ("stop_reason" IS NULL OR "stop_reason" IN ('joined', 'reneged', 'withdrawn', 'offer_not_accepted', 'joining_date_passed')),
	CONSTRAINT "pre_joining_journeys_reply_token_check" CHECK ("reply_token" ~ '^[a-f0-9]{32}$')
);--> statement-breakpoint
ALTER TABLE "pre_joining_journeys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pre_joining_journeys" ADD CONSTRAINT "pre_joining_journeys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_joining_journeys" ADD CONSTRAINT "fk_pre_joining_journeys_application" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_joining_journeys" ADD CONSTRAINT "fk_pre_joining_journeys_candidate" FOREIGN KEY ("tenant_id","candidate_id") REFERENCES "public"."candidates"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_joining_journeys" ADD CONSTRAINT "fk_pre_joining_journeys_offer" FOREIGN KEY ("tenant_id","offer_id") REFERENCES "public"."offers"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_pre_joining_journeys_status" ON "pre_joining_journeys" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "pre_joining_journeys" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
ALTER TABLE public.pre_joining_journeys FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER audit_pre_joining_journeys
AFTER INSERT OR UPDATE OR DELETE ON public.pre_joining_journeys
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

-- ── pre_joining_company_updates ─────────────────────────────────────
CREATE TABLE "pre_joining_company_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link_url" text,
	"video_url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"created_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_pre_joining_company_updates_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "pre_joining_company_updates_title_check" CHECK (char_length("title") BETWEEN 1 AND 200),
	CONSTRAINT "pre_joining_company_updates_body_check" CHECK (char_length("body") BETWEEN 1 AND 5000)
);--> statement-breakpoint
ALTER TABLE "pre_joining_company_updates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pre_joining_company_updates" ADD CONSTRAINT "pre_joining_company_updates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_pre_joining_company_updates_order" ON "pre_joining_company_updates" USING btree ("tenant_id","is_active","sort_order","created_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "pre_joining_company_updates" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
ALTER TABLE public.pre_joining_company_updates FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER audit_pre_joining_company_updates
AFTER INSERT OR UPDATE OR DELETE ON public.pre_joining_company_updates
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

-- ── pre_joining_touchpoints ─────────────────────────────────────────
-- The drain queue. Status ladder:
--   scheduled → processing → sent | skipped | failed
--   scheduled → cancelled  (journey stopped / completed)
-- pulse_token_hash: SHA-256 of the random per-touchpoint token put in the
-- check-in link. The raw token only ever lives in the email.
CREATE TABLE "pre_joining_touchpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"journey_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"sequence" integer NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"carries_pulse" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"skip_reason" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"notification_outbox_id" uuid,
	"company_update_id" uuid,
	"pulse_token_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_pre_joining_touchpoints_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_pre_joining_touchpoints_step" UNIQUE("tenant_id","journey_id","step_key","sequence"),
	CONSTRAINT "uniq_pre_joining_touchpoints_pulse_token" UNIQUE("pulse_token_hash"),
	CONSTRAINT "pre_joining_touchpoints_step_key_check" CHECK ("step_key" IN ('welcome', 'pulse', 'company_update', 'two_weeks_to_go', 'one_week_to_go')),
	CONSTRAINT "pre_joining_touchpoints_status_check" CHECK ("status" IN ('scheduled', 'processing', 'sent', 'skipped', 'cancelled', 'failed')),
	CONSTRAINT "pre_joining_touchpoints_attempt_count_check" CHECK ("attempt_count" >= 0),
	CONSTRAINT "pre_joining_touchpoints_sequence_check" CHECK ("sequence" >= 1)
);--> statement-breakpoint
ALTER TABLE "pre_joining_touchpoints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pre_joining_touchpoints" ADD CONSTRAINT "pre_joining_touchpoints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_joining_touchpoints" ADD CONSTRAINT "fk_pre_joining_touchpoints_journey" FOREIGN KEY ("tenant_id","journey_id") REFERENCES "public"."pre_joining_journeys"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_joining_touchpoints" ADD CONSTRAINT "fk_pre_joining_touchpoints_application" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Nullable single-column SET NULL FKs (HANDOVER #63 — compound + NOT NULL
-- tenant_id cannot SET NULL).
ALTER TABLE "pre_joining_touchpoints" ADD CONSTRAINT "fk_pre_joining_touchpoints_outbox" FOREIGN KEY ("notification_outbox_id") REFERENCES "public"."notification_outbox"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_joining_touchpoints" ADD CONSTRAINT "fk_pre_joining_touchpoints_company_update" FOREIGN KEY ("company_update_id") REFERENCES "public"."pre_joining_company_updates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Drain claim: cross-tenant (service role), so tenant_id does not lead.
CREATE INDEX "idx_pre_joining_touchpoints_drain" ON "pre_joining_touchpoints" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "idx_pre_joining_touchpoints_application" ON "pre_joining_touchpoints" USING btree ("tenant_id","application_id","scheduled_for");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "pre_joining_touchpoints" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
ALTER TABLE public.pre_joining_touchpoints FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- ── pre_joining_pulse_responses ─────────────────────────────────────
-- ONE answer per check-in (UNIQUE on touchpoint): a second submit is a 409.
CREATE TABLE "pre_joining_pulse_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"touchpoint_id" uuid NOT NULL,
	"journey_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"on_track" text NOT NULL,
	"feeling" smallint,
	"comment" text,
	"responded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_pre_joining_pulse_responses_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_pre_joining_pulse_responses_touchpoint" UNIQUE("tenant_id","touchpoint_id"),
	CONSTRAINT "pre_joining_pulse_responses_on_track_check" CHECK ("on_track" IN ('yes', 'unsure', 'no')),
	CONSTRAINT "pre_joining_pulse_responses_feeling_check" CHECK ("feeling" IS NULL OR "feeling" BETWEEN 1 AND 5),
	CONSTRAINT "pre_joining_pulse_responses_comment_check" CHECK ("comment" IS NULL OR char_length("comment") <= 1000)
);--> statement-breakpoint
ALTER TABLE "pre_joining_pulse_responses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pre_joining_pulse_responses" ADD CONSTRAINT "pre_joining_pulse_responses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_joining_pulse_responses" ADD CONSTRAINT "fk_pre_joining_pulse_responses_touchpoint" FOREIGN KEY ("tenant_id","touchpoint_id") REFERENCES "public"."pre_joining_touchpoints"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_joining_pulse_responses" ADD CONSTRAINT "fk_pre_joining_pulse_responses_journey" FOREIGN KEY ("tenant_id","journey_id") REFERENCES "public"."pre_joining_journeys"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_joining_pulse_responses" ADD CONSTRAINT "fk_pre_joining_pulse_responses_application" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_pre_joining_pulse_responses_application" ON "pre_joining_pulse_responses" USING btree ("tenant_id","application_id","responded_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "pre_joining_pulse_responses" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
ALTER TABLE public.pre_joining_pulse_responses FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- ── candidate_inbound_messages: journey link + classification state ─
ALTER TABLE "candidate_inbound_messages" ADD COLUMN "journey_id" uuid;--> statement-breakpoint
ALTER TABLE "candidate_inbound_messages" ADD COLUMN "classification_status" text;--> statement-breakpoint
ALTER TABLE "candidate_inbound_messages" ADD COLUMN "classification_error" text;--> statement-breakpoint
ALTER TABLE "candidate_inbound_messages" ADD COLUMN "classified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "candidate_inbound_messages" ADD COLUMN "classifier_model" text;--> statement-breakpoint
ALTER TABLE "candidate_inbound_messages" ADD COLUMN "classifier_prompt_version" text;--> statement-breakpoint
ALTER TABLE "candidate_inbound_messages" ADD CONSTRAINT "candidate_inbound_messages_classification_status_check" CHECK ("classification_status" IS NULL OR "classification_status" IN ('pending', 'done', 'failed', 'skipped'));--> statement-breakpoint
ALTER TABLE "candidate_inbound_messages" ADD CONSTRAINT "fk_candidate_inbound_messages_journey" FOREIGN KEY ("journey_id") REFERENCES "public"."pre_joining_journeys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_candidate_inbound_messages_application" ON "candidate_inbound_messages" USING btree ("tenant_id","application_id","received_at");--> statement-breakpoint

-- ── candidate_risk_signals ──────────────────────────────────────────
-- A named signal + the candidate's own words. No score — see header.
CREATE TABLE "candidate_risk_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"journey_id" uuid,
	"signal_type" text NOT NULL,
	"source" text NOT NULL,
	-- Verbatim from the candidate's message (verified before insert), or
	-- their pulse comment. NULL for a pulse answer with no comment.
	"quote" text,
	"inbound_message_id" uuid,
	"pulse_response_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"alerted_at" timestamp with time zone,
	"acknowledged_by_membership_id" uuid,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_candidate_risk_signals_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "candidate_risk_signals_type_check" CHECK ("signal_type" IN ('other_offer', 'counter_offer', 'joining_date_change', 'doubt_or_hesitation', 'notice_period_issue', 'withdrawing', 'pulse_unsure', 'pulse_not_on_track')),
	CONSTRAINT "candidate_risk_signals_source_check" CHECK ("source" IN ('inbound_email', 'pulse_response')),
	CONSTRAINT "candidate_risk_signals_status_check" CHECK ("status" IN ('open', 'acknowledged')),
	CONSTRAINT "candidate_risk_signals_quote_check" CHECK ("quote" IS NULL OR char_length("quote") <= 1000),
	CONSTRAINT "candidate_risk_signals_origin_check" CHECK (
		("source" = 'inbound_email' AND "inbound_message_id" IS NOT NULL AND "quote" IS NOT NULL)
		OR ("source" = 'pulse_response' AND "pulse_response_id" IS NOT NULL)
	)
);--> statement-breakpoint
ALTER TABLE "candidate_risk_signals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "candidate_risk_signals" ADD CONSTRAINT "candidate_risk_signals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_risk_signals" ADD CONSTRAINT "fk_candidate_risk_signals_application" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_risk_signals" ADD CONSTRAINT "fk_candidate_risk_signals_journey" FOREIGN KEY ("journey_id") REFERENCES "public"."pre_joining_journeys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_risk_signals" ADD CONSTRAINT "fk_candidate_risk_signals_inbound" FOREIGN KEY ("inbound_message_id") REFERENCES "public"."candidate_inbound_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_risk_signals" ADD CONSTRAINT "fk_candidate_risk_signals_pulse" FOREIGN KEY ("pulse_response_id") REFERENCES "public"."pre_joining_pulse_responses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_risk_signals" ADD CONSTRAINT "fk_candidate_risk_signals_ack_membership" FOREIGN KEY ("tenant_id","acknowledged_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_candidate_risk_signals_application" ON "candidate_risk_signals" USING btree ("tenant_id","application_id","status","created_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "candidate_risk_signals" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
ALTER TABLE public.candidate_risk_signals FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER audit_candidate_risk_signals
AFTER INSERT OR UPDATE OR DELETE ON public.candidate_risk_signals
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

-- ── offer_reneges ───────────────────────────────────────────────────
-- An accepted offer the candidate later backed out of. The offer row goes
-- to status 'reneged' (offers.status is free text — no enum to alter), the
-- application to 'withdrawn'; this row keeps the reason. ONE per offer.
CREATE TABLE "offer_reneges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"reason_code" text NOT NULL,
	-- The label as configured when recorded (the lookup may change later).
	"reason_label" text NOT NULL,
	"notes" text,
	"recorded_by_membership_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_offer_reneges_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_offer_reneges_offer" UNIQUE("tenant_id","offer_id"),
	CONSTRAINT "offer_reneges_reason_code_check" CHECK ("reason_code" ~ '^[a-z0-9_]{1,40}$'),
	CONSTRAINT "offer_reneges_notes_check" CHECK ("notes" IS NULL OR char_length("notes") <= 2000)
);--> statement-breakpoint
ALTER TABLE "offer_reneges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "offer_reneges" ADD CONSTRAINT "offer_reneges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_reneges" ADD CONSTRAINT "fk_offer_reneges_application" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_reneges" ADD CONSTRAINT "fk_offer_reneges_offer" FOREIGN KEY ("tenant_id","offer_id") REFERENCES "public"."offers"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_reneges" ADD CONSTRAINT "fk_offer_reneges_membership" FOREIGN KEY ("tenant_id","recorded_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_offer_reneges_recorded" ON "offer_reneges" USING btree ("tenant_id","recorded_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "offer_reneges" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
ALTER TABLE public.offer_reneges FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER audit_offer_reneges
AFTER INSERT OR UPDATE OR DELETE ON public.offer_reneges
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
