-- =====================================================================
-- 0136_template_applicability.sql — C2-F12 (hand-written)
--
-- Plan A foundation F12 (§15 P3): ONE applicability mechanism that answers
-- "which template applies to this requisition?" for every template kind.
--
--   template_assignments            NEW — (template_kind, template_id,
--                                   priority, active, conditions jsonb).
--                                   Conditions are an AND of typed predicates
--                                   over the requisition's org / job
--                                   attributes; '{}' = the kind's default.
--                                   template_kind is format-checked text (the
--                                   kind list is a platform constant in
--                                   @hireops/api-types applicability.ts, so a
--                                   new kind is a code change, not DDL — the
--                                   tenant_lookups.kind precedent).
--                                   template_id is the target row in that
--                                   kind's own table — polymorphic, so NO FK;
--                                   the API validates it at write and the
--                                   resolver skips a target that has vanished.
--   interview_loops                 NEW — named interview loops per tenant
--                                   (loop_key, label, active). Before this a
--                                   tenant had exactly ONE loop.
--   tenant_interview_round_template += loop_key (DEFAULT 'default'): rounds
--                                   now belong to a loop. The old
--                                   (tenant, round_number) unique becomes
--                                   (tenant, loop_key, round_number). Every
--                                   existing row lands in loop 'default', so
--                                   existing tenants see no change.
--                                   scorecard_template_key becomes NULLABLE:
--                                   NULL = "no pinned scorecard — resolve it
--                                   by applicability" (a pinned key still
--                                   wins; applicability only fills the gap).
--
-- Backfill: every existing tenant gets its 'default' loop row (the target an
-- interview_loop assignment points at). Tenants created later get it on first
-- use (the API ensures it idempotently). Inserted BEFORE RLS is forced and
-- before the audit trigger exists, so the backfill neither depends on the
-- migration role's RLS bypass nor floods the audit log.
--
-- No FK from round rows to interview_loops: seed scripts and older writers
-- insert rounds without creating a loop row, and loops are never deleted
-- (deactivated only), so a dangling key can't arise from the app.
--
-- Conventions: tenant_isolation policy + FORCE ROW LEVEL SECURITY + the
-- audit_record_change trigger on both new tables (tenant-editable config).
-- =====================================================================

-- ── interview_loops ─────────────────────────────────────────────────
CREATE TABLE "interview_loops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"loop_key" text NOT NULL,
	"label" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_interview_loops_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_interview_loops_tenant_key" UNIQUE("tenant_id","loop_key"),
	CONSTRAINT "interview_loops_key_check" CHECK ("loop_key" ~ '^[a-z0-9_]{1,64}$'),
	CONSTRAINT "interview_loops_label_check" CHECK (char_length("label") BETWEEN 1 AND 120)
);--> statement-breakpoint
ALTER TABLE "interview_loops" ADD CONSTRAINT "interview_loops_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "interview_loops" ("tenant_id", "loop_key", "label")
SELECT t.id, 'default', 'Default loop' FROM public.tenants t
ON CONFLICT ("tenant_id", "loop_key") DO NOTHING;--> statement-breakpoint
ALTER TABLE "interview_loops" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "interview_loops" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
ALTER TABLE public.interview_loops FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER audit_interview_loops
AFTER INSERT OR UPDATE OR DELETE ON public.interview_loops
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

-- ── tenant_interview_round_template: rounds belong to a loop ────────
ALTER TABLE "tenant_interview_round_template" ADD COLUMN "loop_key" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_interview_round_template" ADD CONSTRAINT "tenant_interview_round_template_loop_key_check" CHECK ("loop_key" ~ '^[a-z0-9_]{1,64}$');--> statement-breakpoint
ALTER TABLE "tenant_interview_round_template" DROP CONSTRAINT "uniq_tenant_interview_round_template_tenant_round";--> statement-breakpoint
ALTER TABLE "tenant_interview_round_template" ADD CONSTRAINT "uniq_tenant_interview_round_template_tenant_loop_round" UNIQUE("tenant_id","loop_key","round_number");--> statement-breakpoint
-- NULL = resolve the scorecard by applicability. The existing shape CHECK
-- (scorecard_template_key ~ '^[a-z0-9_]{1,64}$') is NULL-tolerant as written.
ALTER TABLE "tenant_interview_round_template" ALTER COLUMN "scorecard_template_key" DROP NOT NULL;--> statement-breakpoint

-- ── template_assignments ────────────────────────────────────────────
CREATE TABLE "template_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_kind" text NOT NULL,
	"name" text NOT NULL,
	"template_id" uuid NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_template_assignments_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_template_assignments_kind_name" UNIQUE("tenant_id","template_kind","name"),
	CONSTRAINT "template_assignments_kind_check" CHECK ("template_kind" ~ '^[a-z][a-z0-9_]{1,39}$'),
	CONSTRAINT "template_assignments_name_check" CHECK (char_length("name") BETWEEN 1 AND 120),
	CONSTRAINT "template_assignments_priority_check" CHECK ("priority" BETWEEN -1000 AND 1000),
	CONSTRAINT "template_assignments_conditions_check" CHECK (jsonb_typeof("conditions") = 'object')
);--> statement-breakpoint
ALTER TABLE "template_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "template_assignments" ADD CONSTRAINT "template_assignments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_template_assignments_kind" ON "template_assignments" USING btree ("tenant_id","template_kind","is_active");--> statement-breakpoint
CREATE INDEX "idx_template_assignments_target" ON "template_assignments" USING btree ("tenant_id","template_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "template_assignments" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
ALTER TABLE public.template_assignments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER audit_template_assignments
AFTER INSERT OR UPDATE OR DELETE ON public.template_assignments
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
