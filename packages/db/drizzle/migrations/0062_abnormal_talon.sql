CREATE TABLE "market_benchmarks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"role_title" text NOT NULL,
	"median_salary_minor" bigint NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"ttf_days" integer NOT NULL,
	"availability" text NOT NULL,
	"competitor_demand" text NOT NULL,
	"recommended_rounds" integer NOT NULL,
	"trending_skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_market_benchmarks_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_market_benchmarks_tenant_role" UNIQUE("tenant_id","role_title"),
	CONSTRAINT "market_benchmarks_availability_check" CHECK ("market_benchmarks"."availability" IN ('low', 'medium', 'high')),
	CONSTRAINT "market_benchmarks_competitor_demand_check" CHECK ("market_benchmarks"."competitor_demand" IN ('low', 'medium', 'high')),
	CONSTRAINT "market_benchmarks_median_check" CHECK ("market_benchmarks"."median_salary_minor" >= 0),
	CONSTRAINT "market_benchmarks_ttf_check" CHECK ("market_benchmarks"."ttf_days" >= 0),
	CONSTRAINT "market_benchmarks_rounds_check" CHECK ("market_benchmarks"."recommended_rounds" >= 0)
);
--> statement-breakpoint
ALTER TABLE "market_benchmarks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "requisition_feasibility" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requisition_id" uuid NOT NULL,
	"assessment" jsonb NOT NULL,
	"model" text,
	"prompt_version" text,
	"generated_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_requisition_feasibility_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_requisition_feasibility_per_req" UNIQUE("tenant_id","requisition_id")
);
--> statement-breakpoint
ALTER TABLE "requisition_feasibility" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "market_benchmarks" ADD CONSTRAINT "market_benchmarks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisition_feasibility" ADD CONSTRAINT "requisition_feasibility_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisition_feasibility" ADD CONSTRAINT "fk_requisition_feasibility_requisition" FOREIGN KEY ("tenant_id","requisition_id") REFERENCES "public"."requisitions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisition_feasibility" ADD CONSTRAINT "fk_requisition_feasibility_generated_by" FOREIGN KEY ("tenant_id","generated_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_market_benchmarks_tenant" ON "market_benchmarks" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_requisition_feasibility_req" ON "requisition_feasibility" USING btree ("tenant_id","requisition_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "market_benchmarks" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "requisition_feasibility" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());