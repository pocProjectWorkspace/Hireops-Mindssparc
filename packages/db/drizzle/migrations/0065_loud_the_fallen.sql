CREATE TABLE "hr_round_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"motivation_discussed" boolean DEFAULT false NOT NULL,
	"salary_expectation_discussed" boolean DEFAULT false NOT NULL,
	"culture_fit_assessed" boolean DEFAULT false NOT NULL,
	"work_authorization_verified" boolean DEFAULT false NOT NULL,
	"notice_period_confirmed" boolean DEFAULT false NOT NULL,
	"relocation_willingness" boolean DEFAULT false NOT NULL,
	"notes" text,
	"rating" integer NOT NULL,
	"recommendation" text NOT NULL,
	"completed_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_hr_round_assessments_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_hr_round_assessments_tenant_application" UNIQUE("tenant_id","application_id"),
	CONSTRAINT "hr_round_assessments_rating_check" CHECK ("hr_round_assessments"."rating" BETWEEN 1 AND 5),
	CONSTRAINT "hr_round_assessments_recommendation_check" CHECK ("hr_round_assessments"."recommendation" IN ('proceed', 'hold', 'reject'))
);
--> statement-breakpoint
ALTER TABLE "hr_round_assessments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_round_assessments" ADD CONSTRAINT "hr_round_assessments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_round_assessments" ADD CONSTRAINT "fk_hr_round_assessments_application" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_round_assessments" ADD CONSTRAINT "fk_hr_round_assessments_completed_by" FOREIGN KEY ("tenant_id","completed_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_hr_round_assessments_application" ON "hr_round_assessments" USING btree ("tenant_id","application_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "hr_round_assessments" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());