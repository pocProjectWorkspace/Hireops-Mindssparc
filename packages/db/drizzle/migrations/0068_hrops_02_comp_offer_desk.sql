CREATE TABLE "comp_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"rationale" text NOT NULL,
	"verdict" text NOT NULL,
	"suggested_inr_paise" bigint NOT NULL,
	"model" text,
	"prompt_version" text,
	"generated_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_comp_recommendations_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_comp_recommendations_per_application" UNIQUE("tenant_id","application_id")
);
--> statement-breakpoint
ALTER TABLE "comp_recommendations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "expected_salary_inr_paise" bigint;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "contract_type" text;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "probation_months" integer;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "benefits" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "comp_recommendations" ADD CONSTRAINT "comp_recommendations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comp_recommendations" ADD CONSTRAINT "fk_comp_recommendations_application" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comp_recommendations" ADD CONSTRAINT "fk_comp_recommendations_generated_by" FOREIGN KEY ("tenant_id","generated_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_comp_recommendations_application" ON "comp_recommendations" USING btree ("tenant_id","application_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "comp_recommendations" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());