-- =====================================================================
-- 0129_application_selection_decisions.sql — PC-12 (hand-written)
--
-- The explicit FINAL SELECTION DECISION on an application, recorded by the
-- requisition's hiring manager, a recruiter or an admin after the interview
-- rounds: selected / not_selected / on_hold.
--
--   selected      → the application moves to offer_drafted (the existing
--                   "offer-ready" stage, via transitionApplicationStage and
--                   all its gates). Shown as "Selected — ready for offer
--                   handoff"; the offer itself stays a recruiter action.
--   not_selected  → the existing reject path (recruiter_rejected, closing
--                   email unchanged).
--   on_hold       → recorded only; the stage does not move.
--
-- WHY A TABLE, NOT application_state_transitions.metadata: on_hold moves no
-- stage, so there is no transition row to carry it, and the decision has a
-- life (history, latest-wins chip) of its own.
--
-- APPEND-ONLY, the application_state_transitions posture: SELECT + INSERT
-- tenant_isolation_* policies and NO UPDATE / DELETE policy, so under FORCE
-- RLS an authenticated caller can never rewrite or remove a decision. The
-- latest row by decided_at is the current decision; every earlier row is
-- kept as history. Unlike application_state_transitions, this table IS
-- audited — an on_hold leaves no other trace.
--
-- reason_key / reason_label: the reason list is a tenants.settings lookup
-- (`selectionDecisionReasons`, code default in @hireops/api-types). The label
-- is snapshotted so a later edit of the list cannot rewrite what a past
-- decision said.
--
-- FKs: (tenant_id, application_id) onto uniq_applications_tenant_id_id with
-- CASCADE (the demo/seed cleanup scripts delete applications and know nothing
-- of this table; the audit trigger keeps the trail of anything removed).
-- decided_by_membership_id → tenant_user_memberships(id) SET NULL (a single-
-- column FK so SET NULL can never null tenant_id). transition_id is a plain
-- uuid, deliberately not an FK — a cleanup of the transition trail must
-- neither be blocked by nor cascade into a decision.
-- =====================================================================

CREATE TABLE "application_selection_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"reason_key" text,
	"reason_label" text,
	"notes" text,
	"decided_by_membership_id" uuid,
	"from_stage" "application_stage" NOT NULL,
	"to_stage" "application_stage",
	"transition_id" uuid,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_app_selection_decisions_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "application_selection_decisions_decision_check" CHECK ("decision" IN ('selected', 'not_selected', 'on_hold')),
	CONSTRAINT "application_selection_decisions_notes_len_check" CHECK ("notes" IS NULL OR char_length("notes") <= 2000)
);--> statement-breakpoint
ALTER TABLE "application_selection_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "application_selection_decisions" ADD CONSTRAINT "application_selection_decisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_selection_decisions" ADD CONSTRAINT "fk_app_selection_decisions_application" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_selection_decisions" ADD CONSTRAINT "fk_app_selection_decisions_decided_by" FOREIGN KEY ("decided_by_membership_id") REFERENCES "public"."tenant_user_memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "idx_app_selection_decisions_app_chrono" ON "application_selection_decisions" USING btree ("tenant_id","application_id","decided_at");--> statement-breakpoint

-- ── RLS policies (append-only) ──────────────────────────────────────
CREATE POLICY "tenant_isolation_select" ON "application_selection_decisions" AS PERMISSIVE FOR SELECT TO "authenticated" USING (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "application_selection_decisions" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

ALTER TABLE public.application_selection_decisions FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- ── Audit trigger ───────────────────────────────────────────────────
CREATE TRIGGER audit_application_selection_decisions
AFTER INSERT OR UPDATE OR DELETE ON public.application_selection_decisions
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
