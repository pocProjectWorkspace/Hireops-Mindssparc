CREATE TYPE "public"."application_source" AS ENUM('career_site', 'referral', 'partner_empanelled', 'partner_adhoc', 'job_board', 'agency_search', 'talent_pool', 'whatsapp');--> statement-breakpoint
CREATE TYPE "public"."application_stage" AS ENUM('application_received', 'ai_screening', 'recruiter_review', 'shortlisted', 'tech_interview', 'hr_round', 'offer_drafted', 'offer_accepted', 'offer_declined', 'withdrawn', 'recruiter_rejected');--> statement-breakpoint
CREATE TABLE "persons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"full_name" text,
	"first_name" text,
	"last_name" text,
	"email_primary" text,
	"email_normalised" text,
	"phone_primary" text,
	"phone_normalised" text,
	"location_country" char(2),
	"location_city" text,
	"linkedin_url" text,
	"redacted_at" timestamp with time zone,
	"redaction_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_persons_tenant_id_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "persons" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"source" "application_source" NOT NULL,
	"consent_granted_at" timestamp with time zone,
	"consent_version" text,
	"talent_pool_consent" boolean DEFAULT false NOT NULL,
	"talent_pool_consent_expires_at" timestamp with time zone,
	"current_resume_url" text,
	"parsed_skills" jsonb,
	"years_of_experience" numeric(4, 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_candidates_tenant_id_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "candidates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"requisition_id" uuid NOT NULL,
	"source" "application_source" NOT NULL,
	"current_stage" "application_stage" DEFAULT 'application_received' NOT NULL,
	"stage_entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_recruiter_membership_id" uuid,
	"ai_score" numeric(5, 2),
	"ai_score_explanation" jsonb,
	"ai_scored_at" timestamp with time zone,
	"knockout_passed" boolean,
	"knockout_evaluated_at" timestamp with time zone,
	"knockout_failures" jsonb,
	"source_partner_id" uuid,
	"submitted_by_partner_user_id" uuid,
	"partner_submission_metadata" jsonb,
	"triage_decision_at" timestamp with time zone,
	"triage_decision_reason" text,
	"withdrawn_reason" text,
	"rejected_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_applications_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_applications_candidate_req" UNIQUE("tenant_id","candidate_id","requisition_id")
);
--> statement-breakpoint
ALTER TABLE "applications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "application_state_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"from_stage" "application_stage",
	"to_stage" "application_stage" NOT NULL,
	"transitioned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_membership_id" uuid,
	"reason" text,
	"metadata" jsonb,
	CONSTRAINT "uniq_app_state_transitions_tenant_id_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "application_state_transitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "fk_candidates_person" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."persons"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "fk_applications_candidate" FOREIGN KEY ("tenant_id","candidate_id") REFERENCES "public"."candidates"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "fk_applications_requisition" FOREIGN KEY ("tenant_id","requisition_id") REFERENCES "public"."requisitions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "fk_applications_assigned_recruiter" FOREIGN KEY ("tenant_id","assigned_recruiter_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_state_transitions" ADD CONSTRAINT "application_state_transitions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_state_transitions" ADD CONSTRAINT "fk_app_state_transitions_application" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_state_transitions" ADD CONSTRAINT "fk_app_state_transitions_actor" FOREIGN KEY ("tenant_id","actor_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_persons_email_normalised" ON "persons" USING btree ("tenant_id","email_normalised") WHERE email_normalised IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_persons_phone_normalised" ON "persons" USING btree ("tenant_id","phone_normalised") WHERE phone_normalised IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_persons_redaction_sweep" ON "persons" USING btree ("tenant_id","redacted_at") WHERE redacted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_candidates_one_per_person" ON "candidates" USING btree ("tenant_id","person_id") WHERE person_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_candidates_source" ON "candidates" USING btree ("tenant_id","source","created_at");--> statement-breakpoint
CREATE INDEX "idx_candidates_talent_pool" ON "candidates" USING btree ("tenant_id","talent_pool_consent","talent_pool_consent_expires_at") WHERE talent_pool_consent = true;--> statement-breakpoint
CREATE INDEX "idx_applications_req_stage" ON "applications" USING btree ("tenant_id","requisition_id","current_stage");--> statement-breakpoint
CREATE INDEX "idx_applications_recruiter_stage" ON "applications" USING btree ("tenant_id","assigned_recruiter_membership_id","current_stage");--> statement-breakpoint
CREATE INDEX "idx_applications_candidate" ON "applications" USING btree ("tenant_id","candidate_id");--> statement-breakpoint
CREATE INDEX "idx_applications_partner" ON "applications" USING btree ("tenant_id","source_partner_id","created_at") WHERE source_partner_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_applications_sla" ON "applications" USING btree ("tenant_id","current_stage","stage_entered_at");--> statement-breakpoint
CREATE INDEX "idx_applications_ai_score" ON "applications" USING btree ("tenant_id","ai_score") WHERE ai_score IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_app_state_transitions_app_chrono" ON "application_state_transitions" USING btree ("tenant_id","application_id","transitioned_at");--> statement-breakpoint
CREATE INDEX "idx_app_state_transitions_stage_chrono" ON "application_state_transitions" USING btree ("tenant_id","to_stage","transitioned_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "persons" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "candidates" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "applications" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation_select" ON "application_state_transitions" AS PERMISSIVE FOR SELECT TO "authenticated" USING (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "application_state_transitions" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (tenant_id = current_tenant_id());