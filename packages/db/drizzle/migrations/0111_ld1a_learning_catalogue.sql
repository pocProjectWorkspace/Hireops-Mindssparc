-- =====================================================================
-- 0111_ld1a_learning_catalogue.sql — LD-1A (hand-written)
--
-- L&D in onboarding, backend half. Three tables that let a tenant CURATE
-- learning and a recruiter PUSH it onto a specific new hire's onboarding case.
--
-- The central move: there is NO per-hire assignment table. onboarding_tasks
-- already permits task_type 'training' and 'orientation', and a task already
-- points at a foreign row through `metadata` (document_collection tasks carry
-- metadata->>'documentTypeId'). A learning assignment is therefore an ordinary
-- onboarding task carrying metadata->>'learningResourceId' — so case rollup,
-- overdue logic, the internal case-detail surface, updateOnboardingTaskStatus
-- and the audit trail all apply for free. onboarding_tasks is UNCHANGED here.
--
--   learning_resources    the catalogue of POINTERS. HireOps orchestrates
--                         learning, it does not host it: `url` is the payload
--                         (SharePoint / Drive / unlisted video / LMS deep link)
--                         and file upload is deliberately out of scope.
--                         `external_ref` is the Workday Learning seam.
--                         unique(tenant_id, title) is the idempotent upsert key
--                         (the jd_templates convention).
--   learning_tracks       curated bundles. layer 'organisation' (company
--                         induction, optionally scoped to a BU) or 'role'
--                         (bound to EXACTLY ONE of position_id / role_family —
--                         enforced by learning_tracks_binding_check).
--   learning_track_items  a track's ordered contents, with is_required and a
--                         due_offset_days relative to expected_start_date.
--
-- learning_skill_map (the per-individual upskilling layer) is deliberately NOT
-- in this migration — it is derived per hire from the JD-vs-candidate skill gap
-- and lands in LD-2.
--
-- House discipline: text + CHECK rather than new pgEnums; compound
-- unique(tenant_id, id) on every table so peers can compound-FK them; compound
-- FKs to tenant-scoped parents. Compound FKs cannot cleanly SET NULL (HANDOVER
-- reality #63), so the business-unit / position / resource references are ON
-- DELETE RESTRICT — all three parents are archived, never deleted (the
-- positions.comp_band_id precedent). A track OWNS its items (CASCADE).
--
-- FORCE ROW LEVEL SECURITY + the audit_record_change() triggers are folded into
-- this same file rather than a companion migration: this migration is
-- hand-written end to end (drizzle's .enableRLS() emits ENABLE but never FORCE,
-- which is the only reason 0105/0106 and 0107/0108 were split). lint-rls
-- (FND-15c) requires ENABLE + FORCE + a tenant_isolation policy on every
-- tenant-scoped table; an admin/hr_head edit to the learning catalogue is
-- audit-worthy exactly like comp_bands (0106) and panel_pools (0108).
-- =====================================================================

CREATE TABLE "learning_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"provider" text NOT NULL,
	"url" text NOT NULL,
	"external_ref" text,
	"estimated_minutes" integer,
	"is_archived" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by_membership_id" uuid,
	"updated_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_learning_resources_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_learning_resources_tenant_title" UNIQUE("tenant_id","title"),
	CONSTRAINT "learning_resources_provider_check" CHECK ("learning_resources"."provider" IN ('workday_learning', 'linkedin_learning', 'cornerstone', 'internal_doc', 'video', 'link', 'other')),
	CONSTRAINT "learning_resources_estimated_minutes_check" CHECK ("learning_resources"."estimated_minutes" IS NULL OR "learning_resources"."estimated_minutes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "learning_resources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "learning_resources" ADD CONSTRAINT "learning_resources_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_learning_resources_tenant" ON "learning_resources" USING btree ("tenant_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "learning_resources" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

CREATE TABLE "learning_tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"layer" text NOT NULL,
	"business_unit_id" uuid,
	"position_id" uuid,
	"role_family" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by_membership_id" uuid,
	"updated_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_learning_tracks_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "learning_tracks_layer_check" CHECK ("learning_tracks"."layer" IN ('organisation', 'role')),
	CONSTRAINT "learning_tracks_binding_check" CHECK (
		(
			"learning_tracks"."layer" = 'role'
			AND (
				("learning_tracks"."position_id" IS NOT NULL AND "learning_tracks"."role_family" IS NULL)
				OR ("learning_tracks"."position_id" IS NULL AND "learning_tracks"."role_family" IS NOT NULL)
			)
		) OR (
			"learning_tracks"."layer" = 'organisation'
			AND "learning_tracks"."position_id" IS NULL
			AND "learning_tracks"."role_family" IS NULL
		)
	)
);
--> statement-breakpoint
ALTER TABLE "learning_tracks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "learning_tracks" ADD CONSTRAINT "learning_tracks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Compound (tenant_id, …) FKs to tenant-scoped parents; RESTRICT because a
-- compound FK cannot cleanly SET NULL (reality #63) and both parents archive.
ALTER TABLE "learning_tracks" ADD CONSTRAINT "fk_learning_tracks_business_unit" FOREIGN KEY ("tenant_id","business_unit_id") REFERENCES "public"."business_units"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_tracks" ADD CONSTRAINT "fk_learning_tracks_position" FOREIGN KEY ("tenant_id","position_id") REFERENCES "public"."positions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_learning_tracks_tenant" ON "learning_tracks" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_learning_tracks_layer" ON "learning_tracks" USING btree ("tenant_id","layer");--> statement-breakpoint
CREATE INDEX "idx_learning_tracks_position" ON "learning_tracks" USING btree ("tenant_id","position_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "learning_tracks" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

CREATE TABLE "learning_track_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"track_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_required" boolean DEFAULT true NOT NULL,
	"due_offset_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_learning_track_items_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_learning_track_items_track_resource" UNIQUE("tenant_id","track_id","resource_id")
);
--> statement-breakpoint
ALTER TABLE "learning_track_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "learning_track_items" ADD CONSTRAINT "learning_track_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A track OWNS its items; a resource is archived, never deleted.
ALTER TABLE "learning_track_items" ADD CONSTRAINT "fk_learning_track_items_track" FOREIGN KEY ("tenant_id","track_id") REFERENCES "public"."learning_tracks"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_track_items" ADD CONSTRAINT "fk_learning_track_items_resource" FOREIGN KEY ("tenant_id","resource_id") REFERENCES "public"."learning_resources"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_learning_track_items_track" ON "learning_track_items" USING btree ("tenant_id","track_id");--> statement-breakpoint
CREATE INDEX "idx_learning_track_items_resource" ON "learning_track_items" USING btree ("tenant_id","resource_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "learning_track_items" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

-- FORCE RLS (lint-rls requires ENABLE + FORCE) ------------------------------
ALTER TABLE public.learning_resources FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.learning_tracks FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.learning_track_items FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Audit triggers (tenant-editable config — same treatment as comp_bands) ----
CREATE TRIGGER audit_learning_resources
AFTER INSERT OR UPDATE OR DELETE ON public.learning_resources
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_learning_tracks
AFTER INSERT OR UPDATE OR DELETE ON public.learning_tracks
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_learning_track_items
AFTER INSERT OR UPDATE OR DELETE ON public.learning_track_items
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
