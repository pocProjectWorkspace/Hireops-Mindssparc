-- =====================================================================
-- 0107_t33_panel_pools.sql — T3.3 / G16 (hand-written)
--
-- Panel pools (Phase 3, Org structure — FINAL ticket). A tenant's editable set
-- of NAMED interview-panel pools — a reusable roster of memberships an
-- interview-plan round can draw its default panel FROM, so a round's panel comes
-- from a managed group rather than a per-round manual checkbox pick every time.
--
-- HONESTY: not a decorative dropdown. When an interview-plan round carries a
-- panelPoolId with NO manual override, upsertInterviewPlan COPIES the pool's
-- member membership-ids onto interview_plans.default_panel_membership_ids — the
-- SAME advisory uuid[] INT-02 already reads to seed interview_panelists. So the
-- chosen pool genuinely drives the round's panel. interview_plans.panel_pool_id
-- is retained as provenance (mirrors positions.comp_band_id), so an override
-- (explicit member ids) is visible as a divergence from the linked pool.
--
-- Compound (tenant_id, id) unique lets panel_pool_members + interview_plans
-- compound-FK a pool (mirrors uniq_comp_bands_tenant_id_id). Pools are archived,
-- never deleted: interview_plans.panel_pool_id FK is ON DELETE RESTRICT (the
-- positions.comp_band_id precedent). A pool OWNS its member rows
-- (panel_pool_members compound-FKs the pool ON DELETE CASCADE); the member FK to
-- tenant_user_memberships is ON DELETE RESTRICT (the interview_panelists
-- precedent — a compound FK cannot cleanly SET NULL, HANDOVER reality #63).
--
-- Hand-written (the drizzle snapshot chain is behind the schema — known debt).
-- Force-RLS + audit-trigger companion lands in 0108.
-- =====================================================================

CREATE TABLE "panel_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"focus" text,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_panel_pools_tenant_name" UNIQUE("tenant_id","name"),
	CONSTRAINT "uniq_panel_pools_tenant_id_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "panel_pools" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "panel_pools" ADD CONSTRAINT "panel_pools_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_panel_pools_tenant" ON "panel_pools" USING btree ("tenant_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "panel_pools" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

CREATE TABLE "panel_pool_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"panel_pool_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_panel_pool_members_pool_membership" UNIQUE("tenant_id","panel_pool_id","membership_id")
);
--> statement-breakpoint
ALTER TABLE "panel_pool_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "panel_pool_members" ADD CONSTRAINT "panel_pool_members_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A pool OWNS its member rows: dropping (or an eventual hard-delete of) a pool
-- drops its members. Compound (tenant_id, panel_pool_id).
ALTER TABLE "panel_pool_members" ADD CONSTRAINT "fk_panel_pool_members_pool" FOREIGN KEY ("tenant_id","panel_pool_id") REFERENCES "public"."panel_pools"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The membership FK is ON DELETE RESTRICT (compound FKs can't cleanly SET NULL —
-- the interview_panelists precedent, HANDOVER reality #63).
ALTER TABLE "panel_pool_members" ADD CONSTRAINT "fk_panel_pool_members_membership" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_panel_pool_members_pool" ON "panel_pool_members" USING btree ("tenant_id","panel_pool_id");--> statement-breakpoint
CREATE INDEX "idx_panel_pool_members_membership" ON "panel_pool_members" USING btree ("tenant_id","membership_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "panel_pool_members" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

-- Provenance link from an interview-plan round → the pool its default panel was
-- populated from. Compound (tenant_id, panel_pool_id) FK (a plan + pool share a
-- tenant), ON DELETE RESTRICT (pools are archived, never deleted; mirrors
-- positions.comp_band_id).
ALTER TABLE "interview_plans" ADD COLUMN "panel_pool_id" uuid;--> statement-breakpoint
ALTER TABLE "interview_plans" ADD CONSTRAINT "fk_interview_plans_panel_pool" FOREIGN KEY ("tenant_id","panel_pool_id") REFERENCES "public"."panel_pools"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_interview_plans_panel_pool" ON "interview_plans" USING btree ("tenant_id","panel_pool_id");
