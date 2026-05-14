CREATE TYPE "public"."location_type" AS ENUM('remote', 'hybrid', 'onsite', 'multi');--> statement-breakpoint
CREATE TABLE "headcount_envelopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"business_unit_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"planned_headcount" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "envelope_status_check" CHECK ("headcount_envelopes"."status" IN ('draft', 'approved', 'closed')),
	CONSTRAINT "envelope_period_check" CHECK ("headcount_envelopes"."period_start" <= "headcount_envelopes"."period_end"),
	CONSTRAINT "envelope_planned_check" CHECK ("headcount_envelopes"."planned_headcount" > 0)
);
--> statement-breakpoint
ALTER TABLE "headcount_envelopes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"business_unit_id" uuid NOT NULL,
	"title" text NOT NULL,
	"level" text,
	"function" text,
	"location_type" "location_type" DEFAULT 'onsite' NOT NULL,
	"primary_location" text,
	"comp_band_min" numeric(12, 2),
	"comp_band_max" numeric(12, 2),
	"comp_currency" char(3),
	"hiring_manager_id" uuid,
	"workday_position_wid" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"retired_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "positions_comp_range_check" CHECK (("positions"."comp_band_min" IS NULL OR "positions"."comp_band_max" IS NULL OR "positions"."comp_band_min" <= "positions"."comp_band_max")),
	CONSTRAINT "positions_retired_coherence_check" CHECK (("positions"."is_active" = true AND "positions"."retired_at" IS NULL) OR ("positions"."is_active" = false AND "positions"."retired_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "positions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jd_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"jd_text" text NOT NULL,
	"summary" text,
	"ai_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jd_version_status_check" CHECK ("jd_versions"."status" IN ('draft', 'approved', 'archived')),
	CONSTRAINT "jd_version_number_check" CHECK ("jd_versions"."version_number" >= 1)
);
--> statement-breakpoint
ALTER TABLE "jd_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jd_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"jd_version_id" uuid NOT NULL,
	"skill_name" text NOT NULL,
	"category" text,
	"weight" numeric(4, 2) DEFAULT '1.00' NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jd_skill_weight_check" CHECK ("jd_skills"."weight" >= 0)
);
--> statement-breakpoint
ALTER TABLE "jd_skills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "headcount_envelopes" ADD CONSTRAINT "headcount_envelopes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "headcount_envelopes" ADD CONSTRAINT "headcount_envelopes_business_unit_id_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "headcount_envelopes" ADD CONSTRAINT "headcount_envelopes_approved_by_tenant_user_memberships_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."tenant_user_memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_business_unit_id_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_hiring_manager_id_tenant_user_memberships_id_fk" FOREIGN KEY ("hiring_manager_id") REFERENCES "public"."tenant_user_memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_created_by_tenant_user_memberships_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."tenant_user_memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jd_versions" ADD CONSTRAINT "jd_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jd_versions" ADD CONSTRAINT "jd_versions_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jd_versions" ADD CONSTRAINT "jd_versions_created_by_tenant_user_memberships_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."tenant_user_memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jd_versions" ADD CONSTRAINT "jd_versions_approved_by_tenant_user_memberships_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."tenant_user_memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jd_skills" ADD CONSTRAINT "jd_skills_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jd_skills" ADD CONSTRAINT "jd_skills_jd_version_id_jd_versions_id_fk" FOREIGN KEY ("jd_version_id") REFERENCES "public"."jd_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_envelope_scope" ON "headcount_envelopes" USING btree ("tenant_id","business_unit_id","period_start","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_positions_active_title" ON "positions" USING btree ("tenant_id","business_unit_id","title") WHERE is_active = true;--> statement-breakpoint
CREATE INDEX "idx_positions_bu" ON "positions" USING btree ("tenant_id","business_unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_jd_version" ON "jd_versions" USING btree ("position_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_jd_skill_unique" ON "jd_skills" USING btree ("jd_version_id","skill_name");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "headcount_envelopes" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "positions" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "jd_versions" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "jd_skills" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());