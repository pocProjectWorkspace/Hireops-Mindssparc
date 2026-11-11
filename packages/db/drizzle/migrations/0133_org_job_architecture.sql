-- =====================================================================
-- 0133_org_job_architecture.sql — C1-F3 (hand-written)
--
-- Plan A foundation F3 (+ §15 P1/P2): organisation inside the tenant and
-- the job architecture, plus a generic lookup table for simple lists.
--
--   legal_entities     NEW — legal entity (name, ISO-3166 country, active)
--   locations          NEW — site (name, city, region text, country, entity?,
--                            IANA timezone, active). Country → region → city
--                            is what market intel will key off later.
--   job_functions      NEW — function / job family (key, label, order, active)
--   job_levels         NEW — level / grade / band (key e.g. "IN12", label,
--                            numeric rank for ordering, active)
--   job_profiles       NEW — the central job object: title, function, level
--                            range, default JD template, competencies,
--                            canonical market title, active
--   tenant_lookups     NEW — (kind, key, label, order, active, attrs) for
--                            simple lists. Platform defaults live in code
--                            (@hireops/api-types tenant-lookups.ts); a tenant
--                            row with the same key overrides the default, a
--                            new key adds a value. The resolver never needs
--                            a row to exist.
--   business_units     += legal_entity_id
--   positions          += location_id, job_profile_id, job_function_id,
--                         job_level_id
--   requisitions       += location_id, job_profile_id, job_function_id,
--                         job_level_id, employment_type_key,
--                         requisition_type_key
--   comp_bands         += job_level_id, job_function_id, location_id scope
--                         (NULL = applies to every value) + midpoint_major
--
-- Canonical keys stay stable for analytics while tenants relabel: labels are
-- tenant data, keys are what records store. `kind` is text (format-checked),
-- not a CHECK list, so adding a lookup kind is a code change, not DDL.
--
-- Every new column is NULLABLE: existing rows are untouched, and the existing
-- free-text columns (positions.primary_location / level / function,
-- comp_bands.level) stay as the back-compat display fallback.
--
-- Conventions: compound (tenant_id, x) FKs onto uniq_*_tenant_id_id, ON DELETE
-- RESTRICT (these objects are deactivated, never deleted — the comp_bands
-- precedent, reality #63), tenant_isolation policy + FORCE ROW LEVEL SECURITY
-- and the audit_record_change trigger on every new table (all are
-- tenant-editable configuration).
-- =====================================================================

-- ── legal_entities ──────────────────────────────────────────────────
CREATE TABLE "legal_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"country_code" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_legal_entities_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_legal_entities_tenant_name" UNIQUE("tenant_id","name"),
	CONSTRAINT "legal_entities_name_check" CHECK (char_length("name") BETWEEN 1 AND 160),
	CONSTRAINT "legal_entities_country_code_check" CHECK ("country_code" ~ '^[A-Z]{2}$')
);--> statement-breakpoint
ALTER TABLE "legal_entities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legal_entities" ADD CONSTRAINT "legal_entities_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "legal_entities" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
ALTER TABLE public.legal_entities FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER audit_legal_entities
AFTER INSERT OR UPDATE OR DELETE ON public.legal_entities
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

-- ── locations ───────────────────────────────────────────────────────
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"city" text,
	-- Region / state as text (country → region → city); no region table yet.
	"region" text,
	"country_code" text NOT NULL,
	"legal_entity_id" uuid,
	-- IANA zone (validated in the API); NULL = use the tenant default.
	"timezone" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_locations_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_locations_tenant_name" UNIQUE("tenant_id","name"),
	CONSTRAINT "locations_name_check" CHECK (char_length("name") BETWEEN 1 AND 160),
	CONSTRAINT "locations_city_check" CHECK ("city" IS NULL OR char_length("city") <= 120),
	CONSTRAINT "locations_region_check" CHECK ("region" IS NULL OR char_length("region") <= 120),
	CONSTRAINT "locations_country_code_check" CHECK ("country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "locations_timezone_check" CHECK ("timezone" IS NULL OR char_length("timezone") BETWEEN 1 AND 64)
);--> statement-breakpoint
ALTER TABLE "locations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "fk_locations_legal_entity" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_locations_legal_entity" ON "locations" USING btree ("tenant_id","legal_entity_id");--> statement-breakpoint
CREATE INDEX "idx_locations_geo" ON "locations" USING btree ("tenant_id","country_code","region","city");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "locations" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
ALTER TABLE public.locations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER audit_locations
AFTER INSERT OR UPDATE OR DELETE ON public.locations
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

-- ── job_functions ───────────────────────────────────────────────────
CREATE TABLE "job_functions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_job_functions_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_job_functions_tenant_key" UNIQUE("tenant_id","key"),
	CONSTRAINT "job_functions_key_check" CHECK ("key" ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$'),
	CONSTRAINT "job_functions_label_check" CHECK (char_length("label") BETWEEN 1 AND 120)
);--> statement-breakpoint
ALTER TABLE "job_functions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "job_functions" ADD CONSTRAINT "job_functions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "job_functions" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
ALTER TABLE public.job_functions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER audit_job_functions
AFTER INSERT OR UPDATE OR DELETE ON public.job_functions
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

-- ── job_levels ──────────────────────────────────────────────────────
-- `key` is the stable grade code (e.g. "IN12") — Workday's Compensation
-- Grade maps onto it; `rank` orders levels (higher = more senior).
CREATE TABLE "job_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"rank" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_job_levels_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_job_levels_tenant_key" UNIQUE("tenant_id","key"),
	CONSTRAINT "job_levels_key_check" CHECK ("key" ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$'),
	CONSTRAINT "job_levels_label_check" CHECK (char_length("label") BETWEEN 1 AND 120),
	CONSTRAINT "job_levels_rank_check" CHECK ("rank" BETWEEN 0 AND 10000)
);--> statement-breakpoint
ALTER TABLE "job_levels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "job_levels" ADD CONSTRAINT "job_levels_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "job_levels" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
ALTER TABLE public.job_levels FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER audit_job_levels
AFTER INSERT OR UPDATE OR DELETE ON public.job_levels
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

-- ── job_profiles ────────────────────────────────────────────────────
-- Level RANGE: min..max (both optional). A single-level profile sets only
-- the min (or min = max). The API checks min.rank <= max.rank.
CREATE TABLE "job_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"job_function_id" uuid,
	"job_level_min_id" uuid,
	"job_level_max_id" uuid,
	"default_jd_template_id" uuid,
	-- [{ key, label }] — validated by jobProfileCompetencySchema.
	"competencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	-- The title market data is matched on (Plan B); NULL = use `title`.
	"canonical_market_title" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_job_profiles_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_job_profiles_tenant_title" UNIQUE("tenant_id","title"),
	CONSTRAINT "job_profiles_title_check" CHECK (char_length("title") BETWEEN 2 AND 200),
	CONSTRAINT "job_profiles_market_title_check" CHECK ("canonical_market_title" IS NULL OR char_length("canonical_market_title") BETWEEN 1 AND 200),
	CONSTRAINT "job_profiles_competencies_check" CHECK (jsonb_typeof("competencies") = 'array')
);--> statement-breakpoint
ALTER TABLE "job_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "job_profiles" ADD CONSTRAINT "job_profiles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_profiles" ADD CONSTRAINT "fk_job_profiles_function" FOREIGN KEY ("tenant_id","job_function_id") REFERENCES "public"."job_functions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_profiles" ADD CONSTRAINT "fk_job_profiles_level_min" FOREIGN KEY ("tenant_id","job_level_min_id") REFERENCES "public"."job_levels"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_profiles" ADD CONSTRAINT "fk_job_profiles_level_max" FOREIGN KEY ("tenant_id","job_level_max_id") REFERENCES "public"."job_levels"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- jd_templates are hard-deletable today, so the template link is
-- SET NULL on that column only (PG15 column list — the 0113 precedent).
ALTER TABLE "job_profiles" ADD CONSTRAINT "fk_job_profiles_jd_template" FOREIGN KEY ("tenant_id","default_jd_template_id") REFERENCES "public"."jd_templates"("tenant_id","id") ON DELETE SET NULL ("default_jd_template_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_job_profiles_function" ON "job_profiles" USING btree ("tenant_id","job_function_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "job_profiles" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
ALTER TABLE public.job_profiles FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER audit_job_profiles
AFTER INSERT OR UPDATE OR DELETE ON public.job_profiles
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

-- ── tenant_lookups ──────────────────────────────────────────────────
-- Tenant values over the platform default lists. One row per
-- (tenant, kind, key): same key as a platform default = override (label,
-- order, active, attrs); a new key = a tenant-specific value. Keys are the
-- canonical values records store (e.g. requisitions.employment_type_key).
CREATE TABLE "tenant_lookups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"attrs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_tenant_lookups_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_tenant_lookups_kind_key" UNIQUE("tenant_id","kind","key"),
	CONSTRAINT "tenant_lookups_kind_check" CHECK ("kind" ~ '^[a-z][a-z0-9_]{1,39}$'),
	CONSTRAINT "tenant_lookups_key_check" CHECK ("key" ~ '^[a-z0-9][a-z0-9_]{0,39}$'),
	CONSTRAINT "tenant_lookups_label_check" CHECK (char_length("label") BETWEEN 1 AND 80),
	CONSTRAINT "tenant_lookups_attrs_check" CHECK (jsonb_typeof("attrs") = 'object')
);--> statement-breakpoint
ALTER TABLE "tenant_lookups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_lookups" ADD CONSTRAINT "tenant_lookups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_lookups" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
ALTER TABLE public.tenant_lookups FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER audit_tenant_lookups
AFTER INSERT OR UPDATE OR DELETE ON public.tenant_lookups
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

-- ── business_units: legal entity ────────────────────────────────────
ALTER TABLE "business_units" ADD COLUMN "legal_entity_id" uuid;--> statement-breakpoint
ALTER TABLE "business_units" ADD CONSTRAINT "fk_business_units_legal_entity" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_business_units_legal_entity" ON "business_units" USING btree ("tenant_id","legal_entity_id");--> statement-breakpoint

-- ── positions: structured location + job architecture ───────────────
ALTER TABLE "positions" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "job_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "job_function_id" uuid;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "job_level_id" uuid;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "fk_positions_location" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "fk_positions_job_profile" FOREIGN KEY ("tenant_id","job_profile_id") REFERENCES "public"."job_profiles"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "fk_positions_job_function" FOREIGN KEY ("tenant_id","job_function_id") REFERENCES "public"."job_functions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "fk_positions_job_level" FOREIGN KEY ("tenant_id","job_level_id") REFERENCES "public"."job_levels"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_positions_location" ON "positions" USING btree ("tenant_id","location_id");--> statement-breakpoint
CREATE INDEX "idx_positions_job_profile" ON "positions" USING btree ("tenant_id","job_profile_id");--> statement-breakpoint
CREATE INDEX "idx_positions_job_function" ON "positions" USING btree ("tenant_id","job_function_id");--> statement-breakpoint
CREATE INDEX "idx_positions_job_level" ON "positions" USING btree ("tenant_id","job_level_id");--> statement-breakpoint

-- ── requisitions: same links + lookup keys ──────────────────────────
ALTER TABLE "requisitions" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "requisitions" ADD COLUMN "job_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "requisitions" ADD COLUMN "job_function_id" uuid;--> statement-breakpoint
ALTER TABLE "requisitions" ADD COLUMN "job_level_id" uuid;--> statement-breakpoint
ALTER TABLE "requisitions" ADD COLUMN "employment_type_key" text;--> statement-breakpoint
ALTER TABLE "requisitions" ADD COLUMN "requisition_type_key" text;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_employment_type_key_check" CHECK ("employment_type_key" IS NULL OR "employment_type_key" ~ '^[a-z0-9][a-z0-9_]{0,39}$');--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_requisition_type_key_check" CHECK ("requisition_type_key" IS NULL OR "requisition_type_key" ~ '^[a-z0-9][a-z0-9_]{0,39}$');--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "fk_requisitions_location" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "fk_requisitions_job_profile" FOREIGN KEY ("tenant_id","job_profile_id") REFERENCES "public"."job_profiles"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "fk_requisitions_job_function" FOREIGN KEY ("tenant_id","job_function_id") REFERENCES "public"."job_functions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "fk_requisitions_job_level" FOREIGN KEY ("tenant_id","job_level_id") REFERENCES "public"."job_levels"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_requisitions_location" ON "requisitions" USING btree ("tenant_id","location_id");--> statement-breakpoint
CREATE INDEX "idx_requisitions_job_profile" ON "requisitions" USING btree ("tenant_id","job_profile_id");--> statement-breakpoint
CREATE INDEX "idx_requisitions_job_function" ON "requisitions" USING btree ("tenant_id","job_function_id");--> statement-breakpoint
CREATE INDEX "idx_requisitions_job_level" ON "requisitions" USING btree ("tenant_id","job_level_id");--> statement-breakpoint

-- ── comp_bands: optional scope + midpoint ───────────────────────────
-- A NULL scope column = the band applies to every value of that dimension.
-- midpoint_major (MAJOR units, like min/max) is for compa-ratio later.
ALTER TABLE "comp_bands" ADD COLUMN "job_level_id" uuid;--> statement-breakpoint
ALTER TABLE "comp_bands" ADD COLUMN "job_function_id" uuid;--> statement-breakpoint
ALTER TABLE "comp_bands" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "comp_bands" ADD COLUMN "midpoint_major" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "comp_bands" ADD CONSTRAINT "comp_bands_midpoint_check" CHECK ("midpoint_major" IS NULL OR ("min_major" <= "midpoint_major" AND "midpoint_major" <= "max_major"));--> statement-breakpoint
ALTER TABLE "comp_bands" ADD CONSTRAINT "fk_comp_bands_job_level" FOREIGN KEY ("tenant_id","job_level_id") REFERENCES "public"."job_levels"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comp_bands" ADD CONSTRAINT "fk_comp_bands_job_function" FOREIGN KEY ("tenant_id","job_function_id") REFERENCES "public"."job_functions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comp_bands" ADD CONSTRAINT "fk_comp_bands_location" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_comp_bands_scope" ON "comp_bands" USING btree ("tenant_id","job_level_id","job_function_id","location_id");
