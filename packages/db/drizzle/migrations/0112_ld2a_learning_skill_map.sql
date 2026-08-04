-- =====================================================================
-- 0112_ld2a_learning_skill_map.sql — LD-2A (hand-written)
--
-- The fourth learning table, and the engine behind layer 3 of the client's
-- ask: the INDIVIDUAL'S capability gaps.
--
-- Layers 1 and 2 (organisation induction, role tracks — 0111) are curated
-- bundles someone authors once. Layer 3 is per-individual BY DEFINITION —
-- nobody can pre-author it, because it depends on the gap between THIS hire
-- and THIS role. So the org does not curate the plan; it curates
--
--       WHICH RESOURCE CLOSES WHICH SKILL
--
-- and the system assembles the per-hire plan from the JD-vs-candidate skill
-- comparison HireOps already ran at application time (the same comparison the
-- Insights skill-gap chart draws — extracted into apps/api/src/lib/skill-match.ts
-- in this ticket so both callers share one implementation).
--
-- learning_skill_map is therefore a MAP, not a track: one row per
-- (skill_name → resource). getSuggestedLearningForCase derives the hire's
-- missing skills, looks each up here, and returns SUGGESTIONS carrying the
-- skill they close. It assigns NOTHING. There stays exactly one way learning
-- reaches a hire — assignLearningToCase, the explicit push (LD-1A).
--
-- `skill_name` is free text deliberately: it must line up with the tenant's own
-- jd_skills.skill_name vocabulary, which is free text too. There is no FK to a
-- skills table because there is no skills table.
--
-- House discipline, identical to 0111: compound unique(tenant_id, id) so peers
-- can compound-FK this table; a compound (tenant_id, resource_id) FK to
-- learning_resources ON DELETE RESTRICT (resources are ARCHIVED, never deleted
-- — and a compound FK cannot cleanly SET NULL, HANDOVER reality #63);
-- ENABLE + FORCE row level security with a tenant_isolation policy (lint-rls /
-- FND-15c requires all three); and an audit_record_change() trigger, because an
-- admin/hr_head edit to the skill map is audit-worthy exactly like the
-- catalogue it points into (0111) and comp_bands (0106).
--
-- FORCE RLS and the trigger are folded into this same file rather than a
-- companion migration because it is hand-written end to end (drizzle's
-- .enableRLS() emits ENABLE but never FORCE, which is the only reason
-- 0105/0106 and 0107/0108 were split).
-- =====================================================================

CREATE TABLE "learning_skill_map" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"skill_name" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by_membership_id" uuid,
	"updated_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_learning_skill_map_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_learning_skill_map_skill_resource" UNIQUE("tenant_id","skill_name","resource_id")
);
--> statement-breakpoint
ALTER TABLE "learning_skill_map" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "learning_skill_map" ADD CONSTRAINT "learning_skill_map_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Compound (tenant_id, resource_id) FK; RESTRICT because a compound FK cannot
-- cleanly SET NULL (reality #63) and resources are archived, never deleted.
ALTER TABLE "learning_skill_map" ADD CONSTRAINT "fk_learning_skill_map_resource" FOREIGN KEY ("tenant_id","resource_id") REFERENCES "public"."learning_resources"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_learning_skill_map_tenant" ON "learning_skill_map" USING btree ("tenant_id");--> statement-breakpoint
-- The read path is "given this hire's missing skills, what closes them?" —
-- lookups are by (tenant, skill).
CREATE INDEX "idx_learning_skill_map_skill" ON "learning_skill_map" USING btree ("tenant_id","skill_name");--> statement-breakpoint
CREATE INDEX "idx_learning_skill_map_resource" ON "learning_skill_map" USING btree ("tenant_id","resource_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "learning_skill_map" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

-- FORCE RLS (lint-rls requires ENABLE + FORCE) ------------------------------
ALTER TABLE public.learning_skill_map FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Audit trigger (tenant-editable config — same treatment as 0111) -----------
CREATE TRIGGER audit_learning_skill_map
AFTER INSERT OR UPDATE OR DELETE ON public.learning_skill_map
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
