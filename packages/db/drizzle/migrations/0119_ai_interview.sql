-- =====================================================================
-- 0119_ai_interview.sql — N4.1 (hand-written)
--
-- Schema and constraints ONLY for the asynchronous AI first-round
-- interviewer (build plan §4, phase N4). There are no procedures, no
-- prompts, no candidate surface and no AI call in this migration — those
-- are N4.2–N4.5. The whole schema step ships as ONE migration so the human
-- applies it once.
--
--   interviews.mode                            gains 'ai_async'
--   interview_plans.mode                       gains 'ai_async'
--   tenant_interview_round_template.mode       gains 'ai_async'
--   interview_recordings.source                gains 'ai_interview'
--   interview_recording_consents.captured_via  gains 'ai_interview_link'
--   ai_interview_sessions                      NEW — the question plan, the
--                                              approval gate, the turn state
--                                              and the candidate link
--
-- ─────────────────────────────────────────────────────────────────────
-- WHY THE AI ROUND IS A ROUND
-- ─────────────────────────────────────────────────────────────────────
-- The alternative shape considered (build plan §8, decision 4) was a
-- pre-interview screening step living OUTSIDE `interviews` entirely. It was
-- rejected. Modelling the AI round as a new `mode` on the existing
-- interview plan means it inherits, unchanged and for free: scheduling and
-- the plan→interview instantiation path (INT-02), `completed_at` /
-- `cancelled_at` (0115), the interview-health and funnel reports that read
-- them (R1.2), the consent resolver, the recording→transcript→notes chain
-- (0116) and the 30-day media retention sweep (0118). A parallel screening
-- entity would have had to re-implement or be excluded from every one of
-- those, and every existing report would have quietly stopped counting
-- first rounds the day the feature shipped.
--
-- 'ai_async' is deliberately named for WHAT IT IS rather than for the
-- vendor or the medium: asynchronous, structured, one question at a time.
-- Real-time duplex voice is explicitly out of phase (build plan §4, N5);
-- if it ever ships it is a DIFFERENT mode value, not a quiet redefinition
-- of this one.
--
-- ─────────────────────────────────────────────────────────────────────
-- WHY ALL FOUR MODE SITES MOVE TOGETHER
-- ─────────────────────────────────────────────────────────────────────
-- `mode` is text + CHECK, NOT a Postgres enum (HANDOVER reality #114), and
-- the SAME three-value vocabulary is constrained independently in three
-- tables: interview_plans (the blueprint), interviews (the booking) and
-- tenant_interview_round_template (the tenant default loop). A round
-- template can only produce a plan round that can only produce an
-- interview, so widening any one of them alone leaves the vocabulary
-- inconsistent along a path the product actually walks.
--
-- The fourth site is `interviewModeSchema` in
-- packages/api-types/src/enums.ts, widened in the same change. A widened
-- CHECK with a stale zod enum means the api rejects what the database
-- accepts — the failure is a validation error on a legal row, which is
-- worse than either half alone because it looks like a bug in the caller.
--
-- Mechanically this is DROP CONSTRAINT / ADD CONSTRAINT, exactly what 0117
-- did to interview_recording_consents.captured_via. Because these are
-- CHECKs and not enum types there is no ALTER TYPE, no declaration-order
-- hazard and no transaction restriction. No data migration either: every
-- existing row carries one of the three original values and stays valid.
--
-- ─────────────────────────────────────────────────────────────────────
-- THE OTHER TWO WIDENINGS
-- ─────────────────────────────────────────────────────────────────────
-- interview_recordings.source — 0116 wrote this discriminator as an open
-- question ('manual_upload' | 'vendor_bot') precisely so a third ingestion
-- path would be an adapter rather than a migration of the whole chain.
-- 'ai_interview' is that third path: the media is produced by the
-- candidate's own browser inside the AI round, so there is no vendor and
-- no recruiter upload, and `vendor` / `vendor_ref` stay NULL for the same
-- reason they do on the manual path.
--
-- interview_recording_consents.captured_via — same argument 0117 made for
-- 'internal_revocation', which is HONESTY OF PROVENANCE. Consent given by
-- a candidate on the AI interview entry screen must never be
-- indistinguishable from consent given by clicking the interview confirm
-- page: different disclosure copy, different moment, different thing being
-- agreed to. Everything else about that table is untouched — still
-- append-only, still SELECT+INSERT-only RLS under FORCE RLS, still
-- purpose-scoped to 'interview_recording', still no seam by which staff can
-- manufacture a grant.
--
-- ─────────────────────────────────────────────────────────────────────
-- DELIBERATELY UNCHANGED: uniq_interview_recordings_per_interview
-- ─────────────────────────────────────────────────────────────────────
-- ONE AI round still produces ONE recording row. The obvious-looking move
-- — relax that unique so each answer gets its own recording — is wrong:
-- per-question boundaries already have a home in
-- interview_transcripts.segments, which carries startMs/endMs per segment
-- and is the shape the notetaker, the drain worker and the N4.4 evidence
-- report all read. Forking the artefact shape to get boundaries that
-- already exist would buy nothing and would cost every downstream reader a
-- branch on source. The answers are stitched into one artefact on submit.
--
-- ─────────────────────────────────────────────────────────────────────
-- ai_interview_sessions — NOTE THE ABSENCE
-- ─────────────────────────────────────────────────────────────────────
-- This table carries NO score, NO rating, NO ranking, NO recommendation,
-- NO pass/fail, NO sentiment and NO confidence column, and it never will.
-- 0116 set the precedent on interview_notes and stated it in the DDL: the
-- omission is a product stance, not an unfinished schema. An AI round makes
-- it load-bearing rather than merely principled — the product position is
-- THE AI ROUND PRODUCES EVIDENCE; A HUMAN ADVANCES OR REJECTS (build plan
-- §5). GDPR Art. 22 forbids a decision based solely on automated
-- processing where the effect is legally or similarly significant, and the
-- EU AI Act puts candidate filtering in Annex III. A future ticket must not
-- read this list of columns as a gap to be filled.
--
-- The same clause bans inference beyond the words: no psychometric,
-- personality, fluency or demographic derivation from voice, video or text.
-- There is no column here to put one in, which is the point.
--
-- ─────────────────────────────────────────────────────────────────────
-- ai_interview_sessions — THE STATUS LADDER
-- ─────────────────────────────────────────────────────────────────────
--   draft        questions generated, NOT yet seen or approved by a human.
--                Regenerating replaces them; nothing has been issued.
--   approved     a named recruiter approved the question set. This is the
--                instant the questions FREEZE (questions_frozen_at), and
--                the approval-gate CHECK below makes it impossible to leave
--                'draft' without one.
--   issued       the signed link exists and the invite has gone out.
--   in_progress  the candidate opened the link and started answering.
--   submitted    the candidate finished; the answers are stitched into the
--                recording and the transcript_outbox row is enqueued.
--                TERMINAL, and the only success terminal.
--   expired      expires_at passed with no submission. TERMINAL.
--   cancelled    pulled by a recruiter, or by the round being cancelled.
--                TERMINAL, and reachable from any earlier state including
--                'draft' — hence the approval-gate CHECK exempts it.
--
-- The ladder tracks the SESSION, not the interview. interviews.status
-- (scheduled → completed / cancelled / no_show) remains the authority on
-- the round itself, and the two are set independently: a 'submitted'
-- session on a 'scheduled' interview is the normal shape between the
-- candidate finishing and a human reviewing the evidence.
--
-- Conventions are 0116's throughout: composite (tenant_id, id) UNIQUE so
-- the row can be a compound-FK target, compound (tenant_id, <parent>_id)
-- FKs so a cross-tenant reference is impossible at the database level
-- (HANDOVER §4.5), tenant_isolation RLS + FORCE ROW LEVEL SECURITY.
--
-- It DOES get an audit trigger, unlike interview_recording_consents and
-- transcript_outbox. Those are logs whose every row is immutable by
-- construction; this is mutable governed state — an approval, a freeze, and
-- a status that walks a ladder — which is exactly what audit_record_change()
-- exists for. Same call as interview_recordings and interview_notes.
-- =====================================================================

-- ── 1. mode: 'ai_async' on all three tables that constrain it ───────
ALTER TABLE "interviews"
	DROP CONSTRAINT "interviews_mode_check";--> statement-breakpoint
ALTER TABLE "interviews"
	ADD CONSTRAINT "interviews_mode_check"
	CHECK ("mode" IN ('video', 'onsite', 'phone', 'ai_async'));--> statement-breakpoint

ALTER TABLE "interview_plans"
	DROP CONSTRAINT "interview_plans_mode_check";--> statement-breakpoint
ALTER TABLE "interview_plans"
	ADD CONSTRAINT "interview_plans_mode_check"
	CHECK ("mode" IN ('video', 'onsite', 'phone', 'ai_async'));--> statement-breakpoint

ALTER TABLE "tenant_interview_round_template"
	DROP CONSTRAINT "tenant_interview_round_template_mode_check";--> statement-breakpoint
ALTER TABLE "tenant_interview_round_template"
	ADD CONSTRAINT "tenant_interview_round_template_mode_check"
	CHECK ("mode" IN ('video', 'onsite', 'phone', 'ai_async'));--> statement-breakpoint

-- ── 2. interview_recordings.source: 'ai_interview' ──────────────────
ALTER TABLE "interview_recordings"
	DROP CONSTRAINT "interview_recordings_source_check";--> statement-breakpoint
ALTER TABLE "interview_recordings"
	ADD CONSTRAINT "interview_recordings_source_check"
	CHECK ("source" IN ('manual_upload', 'vendor_bot', 'ai_interview'));--> statement-breakpoint

-- ── 3. interview_recording_consents.captured_via: 'ai_interview_link' ─
ALTER TABLE "interview_recording_consents"
	DROP CONSTRAINT "interview_recording_consents_captured_via_check";--> statement-breakpoint
ALTER TABLE "interview_recording_consents"
	ADD CONSTRAINT "interview_recording_consents_captured_via_check"
	CHECK ("captured_via" IN ('candidate_confirm_link', 'internal_revocation', 'ai_interview_link'));--> statement-breakpoint

-- ── 4. ai_interview_sessions ────────────────────────────────────────
-- ONE session per interview (uniq …_per_interview): an AI round is a round,
-- and a round that has to be re-run replaces its session rather than
-- accumulating siblings nothing downstream could choose between. Same
-- rationale as uniq_interview_recordings_per_interview.
--
-- `questions` is a jsonb ORDERED ARRAY, one entry per question, and each
-- entry carries the question text AND THE RUBRIC KEY IT PROBES. That key
-- maps onto interviews.scorecard_criteria_snapshot (0102) — the resolved,
-- ordered [{key,label}] a HUMAN panellist is scored against, frozen at
-- schedule time. Reusing it rather than inventing a parallel vocabulary is
-- what lets the N4.4 evidence report speak in the same terms as a human
-- scorecard, and inherits 0102's anti-drift guarantee for free.
--
-- jsonb rather than a child table for the same reason interview_prep's
-- payload is jsonb: nothing queries INTO a question, the api reads the whole
-- plan or none of it, and a prompt-shape evolution must not need a
-- migration. `turn_state` is jsonb for the same reason and more strongly —
-- it is per-answer capture bookkeeping (which question the candidate is on,
-- what has been captured, what failed and was retried) whose shape WILL
-- move during N4.3, and none of it is worth a migration.
--
-- `questions_frozen_at` is the discriminator between "generated but not yet
-- approved" and "frozen and issued". It is stamped at the draft → approved
-- transition, together with the approval legs, because approval is what
-- makes the set immutable. It looks redundant with approved_at and is not:
-- approved_at answers "when did a human say yes", questions_frozen_at
-- answers "from when is this content immutable", and the CHECK below turns
-- the pairing into a database guarantee rather than a convention.
--
-- `link_token_hash` is SHA-256 ONLY — the raw token lives in the invitation
-- email and nowhere else, exactly as interviews.confirm_signed_link_token_hash
-- (0054) does it, with the same partial index for the unauthenticated
-- lookup. Single-use redemption stays where it already lives, in
-- signed_link_uses; this column is the lookup key, not the redemption log.
--
-- `model` + `prompt_version` stamp the QUESTION GENERATION only, per
-- interview_prep's provenance convention. The evidence report's own
-- provenance is stamped on interview_notes by N4.4 and is a separate call
-- with a separate feature key.
CREATE TABLE "ai_interview_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"interview_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	-- Ordered [{ key, prompt, rubricKey, ... }] — see the header. NOT NULL
	-- with no default: the row is created BY the generation call, so an
	-- empty array would only ever be a lie about what was generated.
	"questions" jsonb NOT NULL,
	"questions_frozen_at" timestamp with time zone,
	"approved_by_membership_id" uuid,
	"approved_at" timestamp with time zone,
	-- Per-answer capture bookkeeping. '{}' is the honest empty state for a
	-- session nobody has started.
	"turn_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"link_token_hash" text,
	"started_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"model" text,
	"prompt_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_ai_interview_sessions_tenant_id_id" UNIQUE("tenant_id","id"),
	-- ONE session per AI round.
	CONSTRAINT "uniq_ai_interview_sessions_per_interview" UNIQUE("tenant_id","interview_id"),
	CONSTRAINT "ai_interview_sessions_status_check" CHECK ("status" IN ('draft', 'approved', 'issued', 'in_progress', 'submitted', 'expired', 'cancelled')),
	-- THE APPROVAL GATE, in the database. No session may leave 'draft' for
	-- any state a candidate can see without a NAMED HUMAN having approved
	-- the question set and the set having frozen at that moment. This is the
	-- "questions are shown to the recruiter for approval before the invite
	-- goes out" rule expressed as a constraint instead of as procedure code
	-- that a later ticket could route around. 'cancelled' is exempt because
	-- a draft can legitimately be abandoned before anyone approves it.
	CONSTRAINT "ai_interview_sessions_approval_check" CHECK (
		"status" IN ('draft', 'cancelled')
		OR ("approved_by_membership_id" IS NOT NULL AND "approved_at" IS NOT NULL AND "questions_frozen_at" IS NOT NULL)
	),
	-- 'issued' and everything downstream of it means a link exists. Stated
	-- as a constraint so a session can never claim to have been sent to a
	-- candidate with nothing for the candidate to open.
	CONSTRAINT "ai_interview_sessions_issued_link_check" CHECK (
		"status" NOT IN ('issued', 'in_progress', 'submitted')
		OR "link_token_hash" IS NOT NULL
	)
);--> statement-breakpoint
ALTER TABLE "ai_interview_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- ── Foreign keys ────────────────────────────────────────────────────
-- (tenant_id, interview_id) → interviews CASCADE: the session is derived
-- data describing one round and must not outlive it, same as every other
-- link in the 0116 chain.
--
-- approved_by_membership_id is a provenance leg and therefore RESTRICT, not
-- SET NULL — compound FKs cannot SET NULL (the tenant_id leg is NOT NULL),
-- so per HANDOVER reality #63 we RESTRICT rather than silently erase WHO
-- approved a question set that was put to a candidate. Same treatment as
-- interview_recordings.requested_by, interview_prep.generated_by and
-- offers.drafted_by. The column is NULLABLE for the draft state; a compound
-- FK is MATCH SIMPLE, so a NULL leg simply means the constraint is not
-- checked for that row, which is exactly the semantics a draft needs (the
-- precedent is interview_plans.panel_pool_id).
ALTER TABLE "ai_interview_sessions" ADD CONSTRAINT "ai_interview_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_interview_sessions" ADD CONSTRAINT "fk_ai_interview_sessions_interview" FOREIGN KEY ("tenant_id","interview_id") REFERENCES "public"."interviews"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_interview_sessions" ADD CONSTRAINT "fk_ai_interview_sessions_approved_by" FOREIGN KEY ("tenant_id","approved_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- ── Indexes ─────────────────────────────────────────────────────────
-- "What is awaiting approval / still in flight for this tenant?" — the
-- recruiter-side worklist read. idx_interview_recordings_status precedent.
CREATE INDEX "idx_ai_interview_sessions_status" ON "ai_interview_sessions" USING btree ("tenant_id","status");--> statement-breakpoint
-- The unauthenticated candidate route resolves the tenant FROM the hash, so
-- tenant_id cannot lead here. Partial, because only issued sessions have a
-- token and the population that does is the only one ever looked up this
-- way. Exactly idx_interviews_confirm_token_hash's shape (0054).
CREATE INDEX "idx_ai_interview_sessions_link_token_hash" ON "ai_interview_sessions" USING btree ("link_token_hash") WHERE link_token_hash IS NOT NULL;--> statement-breakpoint

-- ── RLS policy ──────────────────────────────────────────────────────
-- Standard FOR ALL tenant_isolation: unlike the consent log this row is
-- meant to be updated in place as the session walks its ladder.
CREATE POLICY "tenant_isolation" ON "ai_interview_sessions" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

ALTER TABLE public.ai_interview_sessions FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- ── Audit trigger ───────────────────────────────────────────────────
-- Mutable governed state — see the header. The approval and the freeze are
-- precisely the facts a regulator or a rejected candidate would ask about.
CREATE TRIGGER audit_ai_interview_sessions
AFTER INSERT OR UPDATE OR DELETE ON public.ai_interview_sessions
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
