-- =====================================================================
-- 0116_interview_notetaker.sql — N1 (hand-written)
--
-- The capture + derivation chain for the interview notetaker (build plan
-- phase R2 / N2.1). Schema and config ONLY — the procedures, the upload
-- surface, the drain worker and the AI call land in N2–N5. The whole
-- phase ships as ONE migration so the human applies it once.
--
--   interview_recording_consents  append-only consent event log
--   interview_recordings          one media artefact per interview
--   interview_transcripts         one transcript per interview
--   interview_notes               one derived AI notes row per interview
--   transcript_outbox             async processing queue
--   interviews.recording_requested  the recruiter's "record this round" toggle
--
-- Product stances the shapes encode (they are not incidental):
--
--   1. VENDOR-AGNOSTIC, MANUAL-UPLOAD FIRST. `interview_recordings.source`
--      discriminates 'manual_upload' (phase 1: a recruiter uploads the
--      audio/VTT a meeting tool already produced) from 'vendor_bot' (a
--      later Recall.ai-style adapter). `vendor` / `vendor_ref` are
--      nullable precisely because the first source has neither.
--
--   2. CONSENT IS PER-INTERVIEW, PURPOSE-SCOPED, AND WITHDRAWABLE. It is
--      deliberately NOT modelled on signed_link_uses — that table's
--      partial unique makes a redemption single-use and terminal, which is
--      the opposite of what a withdrawable permission needs. Consent gets
--      its own append-only log: a withdrawal is a NEW ROW, never an UPDATE,
--      and the effective state is the latest row by created_at.
--
--   3. NO CONSENT → NO RECORDING. There is no verbal-attestation path and
--      no schema affordance for one; a recording exists only where a
--      'granted' consent row is the latest for that interview, and the
--      N2 procedures enforce it.
--
--   4. RECRUITER INTENT IS SEPARATE FROM CONSENT. interviews.recording_requested
--      defaults FALSE. Consent is necessary but not sufficient — both the
--      candidate's permission and the recruiter's explicit ask must be
--      present before anything is captured.
--
--   5. NOTES ASSIST THE PANELLIST, THEY NEVER AUTO-FILL A RECOMMENDATION.
--      interview_notes therefore carries NO score, NO rating and NO
--      hire/no-hire column, and that omission is load-bearing rather than
--      an oversight (SessionBoard.tsx's "not a surveillance surface"
--      stance). A future ticket must not casually add one.
--
-- Conventions are 0114's: composite (tenant_id, id) UNIQUE on every table
-- so it can be a compound-FK target, compound (tenant_id, <parent>_id)
-- FKs, tenant_isolation RLS + FORCE ROW LEVEL SECURITY, audit triggers via
-- public.audit_record_change().
--
-- Audit-trigger placement is NOT uniform here, and the exceptions are
-- reasoned:
--   * interview_recordings / interview_notes — YES. Mutable status and
--     regenerated derived content on governed artefacts.
--   * interview_recording_consents — NO. It IS the log; every row is
--     immutable by construction (same exclusion rationale as
--     signed_link_uses / candidate_dedup_attempts / *_state_transitions).
--   * transcript_outbox — NO. It IS the log of processing attempts (same
--     exclusion as ai_score_outbox / notification_outbox / ai_usage_logs).
--   * interview_transcripts — NO, and this one is a size decision rather
--     than a category one. audit_record_change() stores to_jsonb(OLD) AND
--     to_jsonb(NEW) — the FULL row, both sides — into the partitioned
--     audit_logs. A transcript's full_text plus segments runs to tens of
--     KB, so every write would duplicate the entire transcript (twice, on
--     UPDATE) into the audit partitions for no investigative gain. The
--     recording that produced it and the notes derived from it are BOTH
--     audited, so the chain's provenance is intact without it.
--
-- interview_recording_consents also deviates on RLS: split
-- tenant_isolation_select + tenant_isolation_insert policies rather than
-- one FOR ALL policy, so "a withdrawal is a new row" is enforced by the
-- database and not merely by the code that writes it. Under FORCE RLS an
-- UPDATE or DELETE from `authenticated` matches no policy and touches zero
-- rows. Same treatment as signed_link_uses (0028). A consent log that can
-- be silently edited AND carries no audit trigger would be evidence-free,
-- which is not an acceptable shape for a compliance record.
-- =====================================================================

-- ── 1. interview_recording_consents ─────────────────────────────────
-- Append-only. No unique on (tenant_id, interview_id) — MULTIPLE rows per
-- interview is the entire point (granted → withdrawn → granted again is a
-- legitimate history). The (tenant_id, interview_id, created_at DESC)
-- index makes "what is the current consent?" a single cheap index read.
CREATE TABLE "interview_recording_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"interview_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"purpose" text DEFAULT 'interview_recording' NOT NULL,
	"consent_version" text NOT NULL,
	"captured_via" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" inet,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_interview_recording_consents_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "interview_recording_consents_decision_check" CHECK ("decision" IN ('granted', 'declined', 'withdrawn')),
	-- Purpose-scoped BY CONSTRUCTION: a row here can only ever authorise
	-- interview recording. Any future purpose is a deliberate CHECK edit,
	-- not an accident of a free-text column.
	CONSTRAINT "interview_recording_consents_purpose_check" CHECK ("purpose" = 'interview_recording'),
	CONSTRAINT "interview_recording_consents_captured_via_check" CHECK ("captured_via" IN ('candidate_confirm_link'))
);--> statement-breakpoint
ALTER TABLE "interview_recording_consents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- ── 2. interview_recordings ─────────────────────────────────────────
-- One media artefact per interview. status ladder:
--   pending (requested, nothing uploaded yet) → uploaded → transcribing
--   → transcribed, with failed as the terminal error state.
CREATE TABLE "interview_recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"interview_id" uuid NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"storage_key" text,
	"media_type" text,
	"duration_seconds" integer,
	"size_bytes" bigint,
	"vendor" text,
	"vendor_ref" text,
	"requested_by_membership_id" uuid NOT NULL,
	"uploaded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_interview_recordings_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_interview_recordings_per_interview" UNIQUE("tenant_id","interview_id"),
	CONSTRAINT "interview_recordings_source_check" CHECK ("source" IN ('manual_upload', 'vendor_bot')),
	CONSTRAINT "interview_recordings_status_check" CHECK ("status" IN ('pending', 'uploaded', 'transcribing', 'transcribed', 'failed'))
);--> statement-breakpoint
ALTER TABLE "interview_recordings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- ── 3. interview_transcripts ────────────────────────────────────────
-- segments is a jsonb array of { speaker, startMs, endMs, text } — jsonb
-- rather than a child table because nothing queries INTO a segment; the
-- api reads the whole transcript or nothing, and a provider-shape change
-- must not need a migration (same reasoning as interview_prep's payload).
-- full_text is the flattened form the summariser prompt actually consumes.
CREATE TABLE "interview_transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"interview_id" uuid NOT NULL,
	"recording_id" uuid NOT NULL,
	"segments" jsonb NOT NULL,
	"full_text" text NOT NULL,
	"language" text,
	"provider" text,
	"provider_model" text,
	"word_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_interview_transcripts_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_interview_transcripts_per_interview" UNIQUE("tenant_id","interview_id")
);--> statement-breakpoint
ALTER TABLE "interview_transcripts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- ── 4. interview_notes ──────────────────────────────────────────────
-- The derived AI output. unique (tenant_id, interview_id): ONE notes row
-- per interview — regenerating REPLACES via ON CONFLICT, never appends,
-- exactly interview_prep's rationale (a derived cache, not an audit log).
-- model + prompt_version stamp provenance across a regenerated corpus.
--
-- NOTE THE ABSENCE: no score, no rating, no recommendation column. Notes
-- assist the panellist; they never auto-fill a hire/no-hire. That is a
-- product stance, not an unfinished schema.
CREATE TABLE "interview_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"interview_id" uuid NOT NULL,
	"transcript_id" uuid NOT NULL,
	"summary" text,
	"key_points" jsonb,
	"topics_covered" jsonb,
	"questions_asked" jsonb,
	"follow_ups" jsonb,
	"model" text,
	"prompt_version" text,
	"generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_interview_notes_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_interview_notes_per_interview" UNIQUE("tenant_id","interview_id")
);--> statement-breakpoint
ALTER TABLE "interview_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- ── 5. transcript_outbox ────────────────────────────────────────────
-- Cloned from ai_score_outbox: same status ladder, same attempt_count /
-- attempt_cap retry budget, same claimed_at / claimed_by lease columns so
-- the N3 drain can claim a batch with FOR UPDATE SKIP LOCKED and an orphan
-- sweep can recover rows stuck in 'processing'. The worker itself is N3;
-- the table ships now so the whole phase is one migration.
CREATE TABLE "transcript_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"recording_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"attempt_cap" smallint DEFAULT 5 NOT NULL,
	"last_error" text,
	"last_attempt_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_transcript_outbox_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_transcript_outbox_per_recording" UNIQUE("tenant_id","recording_id"),
	CONSTRAINT "transcript_outbox_status_check" CHECK ("status" IN ('pending', 'processing', 'completed', 'failed'))
);--> statement-breakpoint
ALTER TABLE "transcript_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- ── Foreign keys ────────────────────────────────────────────────────
-- Every domain FK is compound (tenant_id, <parent>_id) → the parent's
-- (tenant_id, id) unique, so a cross-tenant reference is impossible at the
-- database level (HANDOVER §4.5).
--
-- CASCADE runs the whole derived chain: deleting an interview removes its
-- consents and its recording; removing the recording removes the
-- transcript and the outbox row; removing the transcript removes the
-- notes. None of this data may outlive the interview it describes.
--
-- requested_by_membership_id is the one RESTRICT: it is a provenance leg
-- recording WHO asked for the recording, and compound FKs cannot SET NULL
-- (the tenant_id leg is NOT NULL), so per HANDOVER reality #63 we RESTRICT
-- rather than silently orphan the requester — same treatment as
-- interview_prep.generated_by and offers.drafted_by.
ALTER TABLE "interview_recording_consents" ADD CONSTRAINT "interview_recording_consents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_recording_consents" ADD CONSTRAINT "fk_interview_recording_consents_interview" FOREIGN KEY ("tenant_id","interview_id") REFERENCES "public"."interviews"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_recordings" ADD CONSTRAINT "interview_recordings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_recordings" ADD CONSTRAINT "fk_interview_recordings_interview" FOREIGN KEY ("tenant_id","interview_id") REFERENCES "public"."interviews"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_recordings" ADD CONSTRAINT "fk_interview_recordings_requested_by" FOREIGN KEY ("tenant_id","requested_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_transcripts" ADD CONSTRAINT "interview_transcripts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_transcripts" ADD CONSTRAINT "fk_interview_transcripts_recording" FOREIGN KEY ("tenant_id","recording_id") REFERENCES "public"."interview_recordings"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_notes" ADD CONSTRAINT "interview_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_notes" ADD CONSTRAINT "fk_interview_notes_transcript" FOREIGN KEY ("tenant_id","transcript_id") REFERENCES "public"."interview_transcripts"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_outbox" ADD CONSTRAINT "transcript_outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_outbox" ADD CONSTRAINT "fk_transcript_outbox_recording" FOREIGN KEY ("tenant_id","recording_id") REFERENCES "public"."interview_recordings"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ── Indexes ─────────────────────────────────────────────────────────
-- "What is the current consent for this interview?" — ORDER BY created_at
-- DESC LIMIT 1 served entirely by this index. Every read of the consent
-- state is on the no-consent-no-recording path, so it must be cheap.
CREATE INDEX "idx_interview_recording_consents_current" ON "interview_recording_consents" USING btree ("tenant_id","interview_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_interview_recordings_status" ON "interview_recordings" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_interview_transcripts_recording" ON "interview_transcripts" USING btree ("tenant_id","recording_id");--> statement-breakpoint
CREATE INDEX "idx_interview_notes_transcript" ON "interview_notes" USING btree ("tenant_id","transcript_id");--> statement-breakpoint
-- Primary drain query — partial so terminal rows are skipped entirely.
CREATE INDEX "idx_transcript_outbox_queue" ON "transcript_outbox" USING btree ("tenant_id","status","created_at") WHERE status IN ('pending', 'processing');--> statement-breakpoint
-- Orphan-recovery sweep — rows whose claim lease went stale.
CREATE INDEX "idx_transcript_outbox_orphan_sweep" ON "transcript_outbox" USING btree ("claimed_at") WHERE status = 'processing';--> statement-breakpoint

-- ── RLS policies ────────────────────────────────────────────────────
-- interview_recording_consents gets SPLIT policies (select + insert, no
-- update, no delete) — see the header. Everything else gets the standard
-- FOR ALL tenant_isolation; transcript_outbox needs UPDATE because the
-- drain mutates status/attempt_count in place.
CREATE POLICY "tenant_isolation_select" ON "interview_recording_consents" AS PERMISSIVE FOR SELECT TO "authenticated" USING (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "interview_recording_consents" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "interview_recordings" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "interview_transcripts" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "interview_notes" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "transcript_outbox" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

ALTER TABLE public.interview_recording_consents FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.interview_recordings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.interview_transcripts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.interview_notes FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.transcript_outbox FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- ── Audit triggers ──────────────────────────────────────────────────
-- Only the two mutable governed artefacts. The three omissions
-- (interview_recording_consents, interview_transcripts, transcript_outbox)
-- are reasoned in the header — do not "complete the set" without reading
-- it.
CREATE TRIGGER audit_interview_recordings
AFTER INSERT OR UPDATE OR DELETE ON public.interview_recordings
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_interview_notes
AFTER INSERT OR UPDATE OR DELETE ON public.interview_notes
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

-- ── 6. interviews.recording_requested ───────────────────────────────
-- The recruiter's explicit "record this round" intent, DEFAULT false so
-- every existing and every future interview is opt-in. Deliberately
-- separate from consent: the candidate's permission and the recruiter's
-- ask are two independent facts, and recording requires BOTH.
ALTER TABLE "interviews" ADD COLUMN "recording_requested" boolean DEFAULT false NOT NULL;
