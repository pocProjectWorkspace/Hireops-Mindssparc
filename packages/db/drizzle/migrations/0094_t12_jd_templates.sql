-- =====================================================================
-- 0094_t12_jd_templates.sql — T12 / G11 (hand-written)
--
-- The org's curated JD-template library — replaces the hardcoded ROLE_TEMPLATES
-- TS constant with a tenant-scoped, org-editable table. The requisition wizard
-- reads presets from here (falling back to the seeded defaults); admin +
-- hiring_manager curate the library on /jd-library → Templates.
--
-- Money: budget_min_inr / budget_max_inr are annual INR in MAJOR units (rupees)
-- — matches positions.comp_band_* and the wizard's compBand fields, NOT the
-- paise/minor convention. skills is a jsonb array of
-- { skillName, category, weight, isRequired, minYears }.
--
-- Sibling of market_benchmarks (curated, tenant-editable, seeded reference data
-- whose edits are audit-worthy): tenant-scoped + FORCE RLS + tenant_isolation +
-- audit trigger. FORCE RLS + the audit trigger land in 0095.
--
-- Hand-written (the drizzle snapshot chain is behind the schema — known debt).
-- =====================================================================

CREATE TABLE "jd_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"label" text NOT NULL,
	"title" text NOT NULL,
	"role_family" text NOT NULL,
	"seniority" text NOT NULL,
	"location_type" text NOT NULL,
	"budget_min_inr" bigint NOT NULL,
	"budget_max_inr" bigint NOT NULL,
	"extra_context" text DEFAULT '' NOT NULL,
	"body_md" text DEFAULT '' NOT NULL,
	"legal_clauses" text DEFAULT '' NOT NULL,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by_membership_id" uuid,
	"updated_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_jd_templates_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_jd_templates_tenant_title" UNIQUE("tenant_id","title"),
	CONSTRAINT "jd_templates_location_type_check" CHECK ("jd_templates"."location_type" IN ('remote', 'hybrid', 'onsite', 'multi')),
	CONSTRAINT "jd_templates_budget_min_check" CHECK ("jd_templates"."budget_min_inr" >= 0),
	CONSTRAINT "jd_templates_budget_max_check" CHECK ("jd_templates"."budget_max_inr" >= 0)
);
--> statement-breakpoint
ALTER TABLE "jd_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "jd_templates" ADD CONSTRAINT "jd_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_jd_templates_tenant" ON "jd_templates" USING btree ("tenant_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "jd_templates" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
