-- =====================================================================
-- 0121_ai_interview_integrity_and_evidence.sql — AI-INT-1 (hand-written)
--
-- Two additions to the asynchronous AI round (0119), shipped as ONE
-- migration so the human applies it once:
--
--   ai_interview_sessions.integrity_events  NEW jsonb NOT NULL DEFAULT '[]'
--                                           — the integrity log
--   ai_interview_evidence                   NEW — skeleton for the evidence
--                                           report (next ticket); nothing
--                                           writes it yet
--
-- ─────────────────────────────────────────────────────────────────────
-- THE INTEGRITY LOG
-- ─────────────────────────────────────────────────────────────────────
-- An append-only array of [{ type, at, clientAt?, awayMs?, questionKey? }]
-- recorded by the candidate page while the round is in progress: leaving
-- or re-entering full screen, the tab going hidden / visible, the window
-- losing / regaining focus. That is the whole list. Nothing else about the
-- candidate's screen or device is captured, and the candidate is told so
-- in the disclosure (bumped to ai-interview-2026-09-v2 in the same change).
--
-- These are SIGNALS FOR A HUMAN REVIEWER. They are shown next to the
-- answers and are never an input to any automated decision — the §5
-- governance stance of the build plan applies to them exactly as it does
-- to the answers themselves.
--
-- jsonb on the session rather than a child table: the log is small (the
-- server caps it at 500 events per session), is only ever appended to and
-- read whole alongside the session, and has no life of its own. The CHECK
-- pins it to an array so `integrity_events || $new` can never silently
-- degrade into object-merge semantics. The session's existing FORCE RLS
-- tenant_isolation policy and audit trigger cover the new column.
--
-- ─────────────────────────────────────────────────────────────────────
-- ai_interview_evidence — EVIDENCE ONLY, BY DESIGN
-- ─────────────────────────────────────────────────────────────────────
-- One row per submitted session, claimed and filled by a drain worker in
-- the next ticket (status ladder pending → processing → done | failed |
-- skipped, with attempt_count / lease_expires_at / last_error for the
-- claim-and-retry loop, and the idx on (status, lease_expires_at) for the
-- claim query).
--
-- NOTE THE ABSENCE: there is NO score, NO rating, NO ranking, NO
-- recommendation and NO pass/fail column here, and there must never be
-- one. Build plan §5: THE AI ROUND PRODUCES EVIDENCE; A HUMAN ADVANCES OR
-- REJECTS (GDPR Art. 22; EU AI Act Annex III). `evidence` holds what the
-- candidate said, organised against the rubric keys — not a verdict on it.
-- A future ticket must not read the omission as a gap to fill.
--
-- `model` + `prompt_version` stamp the evidence generation call, per the
-- interview_prep provenance convention (distinct from the question
-- generation provenance on ai_interview_sessions).
--
-- Conventions as 0119: compound (tenant_id, session_id) FK onto
-- uniq_ai_interview_sessions_tenant_id_id with CASCADE (derived data must
-- not outlive its session), compound (tenant_id, interview_id) FK onto
-- interviews with CASCADE, UNIQUE (tenant_id, session_id) — ONE evidence
-- row per session — tenant-scoped RLS + FORCE ROW LEVEL SECURITY, and an
-- audit trigger because a status that walks a ladder and a generated
-- artefact put in front of a hiring decision are governed state.
-- =====================================================================

ALTER TABLE "ai_interview_sessions"
	ADD COLUMN "integrity_events" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_interview_sessions"
	ADD CONSTRAINT "ai_interview_sessions_integrity_events_array_check"
	CHECK (jsonb_typeof("integrity_events") = 'array');--> statement-breakpoint

CREATE TABLE "ai_interview_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"interview_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	-- The evidence report itself. NULL until generated. Evidence only — see
	-- the header: no score / rating / recommendation lives here either.
	"evidence" jsonb,
	"model" text,
	"prompt_version" text,
	"generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_ai_interview_evidence_tenant_id_id" UNIQUE("tenant_id","id"),
	-- ONE evidence row per session.
	CONSTRAINT "uniq_ai_interview_evidence_per_session" UNIQUE("tenant_id","session_id"),
	CONSTRAINT "ai_interview_evidence_status_check" CHECK ("status" IN ('pending', 'processing', 'done', 'failed', 'skipped')),
	CONSTRAINT "ai_interview_evidence_attempt_count_check" CHECK ("attempt_count" >= 0)
);--> statement-breakpoint
ALTER TABLE "ai_interview_evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "ai_interview_evidence" ADD CONSTRAINT "ai_interview_evidence_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_interview_evidence" ADD CONSTRAINT "fk_ai_interview_evidence_session" FOREIGN KEY ("tenant_id","session_id") REFERENCES "public"."ai_interview_sessions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_interview_evidence" ADD CONSTRAINT "fk_ai_interview_evidence_interview" FOREIGN KEY ("tenant_id","interview_id") REFERENCES "public"."interviews"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- The drain claim: WHERE status = 'pending' OR (status = 'processing' AND
-- lease_expires_at < now()). Cross-tenant by design (the worker runs as
-- service role), so tenant_id does not lead.
CREATE INDEX "idx_ai_interview_evidence_drain" ON "ai_interview_evidence" USING btree ("status","lease_expires_at");--> statement-breakpoint

-- ── RLS policy ──────────────────────────────────────────────────────
-- Standard FOR ALL tenant_isolation: the row is updated in place as the
-- drain walks it through its ladder.
CREATE POLICY "tenant_isolation" ON "ai_interview_evidence" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

ALTER TABLE public.ai_interview_evidence FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- ── Audit trigger ───────────────────────────────────────────────────
-- Governed state — see the header.
CREATE TRIGGER audit_ai_interview_evidence
AFTER INSERT OR UPDATE OR DELETE ON public.ai_interview_evidence
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
