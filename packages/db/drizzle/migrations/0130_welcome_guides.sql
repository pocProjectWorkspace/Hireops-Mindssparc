-- =====================================================================
-- 0130_welcome_guides.sql — PC-18 (hand-written)
--
-- Pre-joining welcome guide per business unit: the tenant authors source
-- material (BU overview, leaders, culture, first week, links) per business
-- unit plus one organisation-wide default; the AI turns it into a guide
-- STRICTLY grounded in that source; a human reviews, edits and publishes.
-- Only a published version is ever shown to a candidate.
--
--   welcome_guide_sources       NEW — tenant-authored source, one per scope
--   welcome_guides              NEW — versioned generated guides per scope
--   welcome_guide_views         NEW — per-section read receipts (candidate)
--   pre_joining_touchpoints     step_key CHECK += 'welcome_guide'
--
-- Scope: business_unit_id NULL = the organisation-wide default. Uniques use
-- NULLS NOT DISTINCT so the organisation default is one row like any BU.
--
-- Conventions: compound (tenant_id, x) FKs onto uniq_*_tenant_id_id,
-- tenant_isolation policy + FORCE ROW LEVEL SECURITY on every table, audit
-- trigger on governed content (sources, guides). Read receipts are
-- high-volume operational rows and are not audited.
-- =====================================================================

-- ── welcome_guide_sources ───────────────────────────────────────────
CREATE TABLE "welcome_guide_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"business_unit_id" uuid,
	"overview" text DEFAULT '' NOT NULL,
	-- [{ name, title, bio, photoUrl }] — validated by welcomeSourceFieldsSchema.
	"leaders" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"culture" text DEFAULT '' NOT NULL,
	"first_week" text DEFAULT '' NOT NULL,
	-- [{ label, url, kind: link | video }]
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_welcome_guide_sources_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_welcome_guide_sources_scope" UNIQUE NULLS NOT DISTINCT ("tenant_id","business_unit_id"),
	CONSTRAINT "welcome_guide_sources_overview_check" CHECK (char_length("overview") <= 5000),
	CONSTRAINT "welcome_guide_sources_culture_check" CHECK (char_length("culture") <= 5000),
	CONSTRAINT "welcome_guide_sources_first_week_check" CHECK (char_length("first_week") <= 5000),
	CONSTRAINT "welcome_guide_sources_leaders_check" CHECK (jsonb_typeof("leaders") = 'array'),
	CONSTRAINT "welcome_guide_sources_links_check" CHECK (jsonb_typeof("links") = 'array')
);--> statement-breakpoint
ALTER TABLE "welcome_guide_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "welcome_guide_sources" ADD CONSTRAINT "welcome_guide_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- MATCH SIMPLE: a NULL business_unit_id (organisation default) is not checked.
ALTER TABLE "welcome_guide_sources" ADD CONSTRAINT "fk_welcome_guide_sources_business_unit" FOREIGN KEY ("tenant_id","business_unit_id") REFERENCES "public"."business_units"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "welcome_guide_sources" ADD CONSTRAINT "fk_welcome_guide_sources_membership" FOREIGN KEY ("tenant_id","updated_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "welcome_guide_sources" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
ALTER TABLE public.welcome_guide_sources FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER audit_welcome_guide_sources
AFTER INSERT OR UPDATE OR DELETE ON public.welcome_guide_sources
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

-- ── welcome_guides ──────────────────────────────────────────────────
-- Status ladder (per scope):
--   draft → published → superseded   (publishing a newer version)
--   draft → discarded                (regenerated or thrown away)
-- At most ONE draft and ONE published version per scope (partial uniques).
-- A published version is immutable; changing it = a new draft version.
-- model + prompt_version record what generated the text; a draft copied
-- from a published version for editing keeps the original's values, and
-- edited_at / edited_by say a human changed it afterwards.
CREATE TABLE "welcome_guides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"business_unit_id" uuid,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"content" jsonb NOT NULL,
	-- What the post-check dropped (invented people, ungrounded sentences).
	"grounding_report" jsonb DEFAULT '{"dropped":[]}'::jsonb NOT NULL,
	-- The source material the guide was generated from (audit trail).
	"source_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"model" text,
	"prompt_version" text,
	"generated_by_membership_id" uuid,
	"edited_at" timestamp with time zone,
	"edited_by_membership_id" uuid,
	"published_at" timestamp with time zone,
	"published_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_welcome_guides_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_welcome_guides_version" UNIQUE NULLS NOT DISTINCT ("tenant_id","business_unit_id","version"),
	CONSTRAINT "welcome_guides_status_check" CHECK ("status" IN ('draft', 'published', 'superseded', 'discarded')),
	CONSTRAINT "welcome_guides_version_check" CHECK ("version" >= 1),
	CONSTRAINT "welcome_guides_content_check" CHECK (jsonb_typeof("content") = 'object'),
	CONSTRAINT "welcome_guides_published_check" CHECK ("status" NOT IN ('published', 'superseded') OR "published_at" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "welcome_guides" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "welcome_guides" ADD CONSTRAINT "welcome_guides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "welcome_guides" ADD CONSTRAINT "fk_welcome_guides_business_unit" FOREIGN KEY ("tenant_id","business_unit_id") REFERENCES "public"."business_units"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "welcome_guides" ADD CONSTRAINT "fk_welcome_guides_generated_by" FOREIGN KEY ("tenant_id","generated_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "welcome_guides" ADD CONSTRAINT "fk_welcome_guides_edited_by" FOREIGN KEY ("tenant_id","edited_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "welcome_guides" ADD CONSTRAINT "fk_welcome_guides_published_by" FOREIGN KEY ("tenant_id","published_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_welcome_guides_one_published" ON "welcome_guides" USING btree ("tenant_id","business_unit_id") NULLS NOT DISTINCT WHERE "status" = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_welcome_guides_one_draft" ON "welcome_guides" USING btree ("tenant_id","business_unit_id") NULLS NOT DISTINCT WHERE "status" = 'draft';--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "welcome_guides" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
ALTER TABLE public.welcome_guides FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER audit_welcome_guides
AFTER INSERT OR UPDATE OR DELETE ON public.welcome_guides
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

-- ── welcome_guide_views ─────────────────────────────────────────────
-- Simple read receipts: the first time a candidate saw each section of a
-- given guide version, per application. ONE row per (guide, application,
-- section) — re-reading is a no-op.
CREATE TABLE "welcome_guide_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"guide_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"section" text NOT NULL,
	"first_viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_welcome_guide_views_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_welcome_guide_views_section" UNIQUE("tenant_id","guide_id","application_id","section"),
	CONSTRAINT "welcome_guide_views_section_check" CHECK ("section" IN ('welcome', 'business_unit', 'people', 'how_we_work', 'first_week', 'faqs'))
);--> statement-breakpoint
ALTER TABLE "welcome_guide_views" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "welcome_guide_views" ADD CONSTRAINT "welcome_guide_views_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "welcome_guide_views" ADD CONSTRAINT "fk_welcome_guide_views_guide" FOREIGN KEY ("tenant_id","guide_id") REFERENCES "public"."welcome_guides"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "welcome_guide_views" ADD CONSTRAINT "fk_welcome_guide_views_application" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_welcome_guide_views_application" ON "welcome_guide_views" USING btree ("tenant_id","application_id","first_viewed_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "welcome_guide_views" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
ALTER TABLE public.welcome_guide_views FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- ── pre_joining_touchpoints: the new journey step ───────────────────
ALTER TABLE "pre_joining_touchpoints" DROP CONSTRAINT "pre_joining_touchpoints_step_key_check";--> statement-breakpoint
ALTER TABLE "pre_joining_touchpoints" ADD CONSTRAINT "pre_joining_touchpoints_step_key_check" CHECK ("step_key" IN ('welcome', 'welcome_guide', 'pulse', 'company_update', 'two_weeks_to_go', 'one_week_to_go'));
