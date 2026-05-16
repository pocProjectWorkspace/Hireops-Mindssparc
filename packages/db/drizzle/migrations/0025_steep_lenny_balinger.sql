CREATE TYPE "public"."partner_tier" AS ENUM('empanelled', 'ad_hoc');--> statement-breakpoint
CREATE TYPE "public"."partner_user_role" AS ENUM('partner_admin', 'partner_user');--> statement-breakpoint
CREATE TYPE "public"."partner_assignment_status" AS ENUM('active', 'paused', 'ended');--> statement-breakpoint
CREATE TYPE "public"."ownership_claim_status" AS ENUM('active', 'released', 'expired', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."dedup_decision" AS ENUM('allow_new', 'link_existing', 'block_active_claim', 'block_in_pipeline');--> statement-breakpoint
CREATE TABLE "partner_orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"tier" "partner_tier" NOT NULL,
	"legal_entity_name" text,
	"country" char(2),
	"primary_contact_email" text,
	"primary_contact_phone" text,
	"active" boolean DEFAULT true NOT NULL,
	"onboarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_partner_orgs_tenant_id_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "partner_orgs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "partner_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"partner_org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"role" "partner_user_role" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_partner_users_tenant_id_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "partner_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "partner_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"partner_org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"intended_role" "partner_user_role" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_partner_invitations_tenant_id_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "partner_invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "partner_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"partner_org_id" uuid NOT NULL,
	"requisition_id" uuid NOT NULL,
	"assigned_by_membership_id" uuid,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "partner_assignment_status" DEFAULT 'active' NOT NULL,
	"ended_at" timestamp with time zone,
	"notes" text,
	CONSTRAINT "uniq_partner_assignments_tenant_id_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "partner_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "candidate_ownership_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"partner_org_id" uuid NOT NULL,
	"claimed_via_partner_user_id" uuid,
	"claimed_via_application_id" uuid,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "ownership_claim_status" DEFAULT 'active' NOT NULL,
	"released_at" timestamp with time zone,
	"released_reason" text,
	"superseded_by_claim_id" uuid,
	CONSTRAINT "uniq_candidate_ownership_claims_tenant_id_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "candidate_ownership_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "candidate_dedup_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempted_by_partner_user_id" uuid,
	"attempted_by_membership_id" uuid,
	"submitted_email" text,
	"submitted_phone" text,
	"matched_person_id" uuid,
	"decision" "dedup_decision" NOT NULL,
	"decision_reason" text,
	"submission_metadata" jsonb,
	CONSTRAINT "uniq_candidate_dedup_attempts_tenant_id_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "candidate_dedup_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "partner_candidate_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"partner_user_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"application_id" uuid,
	"subject" text,
	"body" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivery_status" text,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "uniq_partner_candidate_messages_tenant_id_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "partner_candidate_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ad_hoc_partner_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"partner_org_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"default_consent_text" text NOT NULL,
	"daily_quota" integer DEFAULT 50 NOT NULL,
	"default_contact_email" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_ad_hoc_partner_domains_tenant_id_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "ad_hoc_partner_domains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "partner_orgs" ADD CONSTRAINT "partner_orgs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_users" ADD CONSTRAINT "partner_users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_users" ADD CONSTRAINT "fk_partner_users_partner_org" FOREIGN KEY ("tenant_id","partner_org_id") REFERENCES "public"."partner_orgs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_invitations" ADD CONSTRAINT "partner_invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_invitations" ADD CONSTRAINT "fk_partner_invitations_partner_org" FOREIGN KEY ("tenant_id","partner_org_id") REFERENCES "public"."partner_orgs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_invitations" ADD CONSTRAINT "fk_partner_invitations_created_by" FOREIGN KEY ("tenant_id","created_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_assignments" ADD CONSTRAINT "partner_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_assignments" ADD CONSTRAINT "fk_partner_assignments_partner_org" FOREIGN KEY ("tenant_id","partner_org_id") REFERENCES "public"."partner_orgs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_assignments" ADD CONSTRAINT "fk_partner_assignments_requisition" FOREIGN KEY ("tenant_id","requisition_id") REFERENCES "public"."requisitions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_assignments" ADD CONSTRAINT "fk_partner_assignments_assigned_by" FOREIGN KEY ("tenant_id","assigned_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_ownership_claims" ADD CONSTRAINT "candidate_ownership_claims_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_ownership_claims" ADD CONSTRAINT "fk_claims_person" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."persons"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_ownership_claims" ADD CONSTRAINT "fk_claims_partner_org" FOREIGN KEY ("tenant_id","partner_org_id") REFERENCES "public"."partner_orgs"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_ownership_claims" ADD CONSTRAINT "fk_claims_partner_user" FOREIGN KEY ("tenant_id","claimed_via_partner_user_id") REFERENCES "public"."partner_users"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_ownership_claims" ADD CONSTRAINT "fk_claims_application" FOREIGN KEY ("tenant_id","claimed_via_application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_ownership_claims" ADD CONSTRAINT "fk_claims_superseded_by" FOREIGN KEY ("tenant_id","superseded_by_claim_id") REFERENCES "public"."candidate_ownership_claims"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_dedup_attempts" ADD CONSTRAINT "candidate_dedup_attempts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_dedup_attempts" ADD CONSTRAINT "fk_dedup_partner_user" FOREIGN KEY ("tenant_id","attempted_by_partner_user_id") REFERENCES "public"."partner_users"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_dedup_attempts" ADD CONSTRAINT "fk_dedup_membership" FOREIGN KEY ("tenant_id","attempted_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_dedup_attempts" ADD CONSTRAINT "fk_dedup_matched_person" FOREIGN KEY ("tenant_id","matched_person_id") REFERENCES "public"."persons"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_candidate_messages" ADD CONSTRAINT "partner_candidate_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_candidate_messages" ADD CONSTRAINT "fk_pcm_partner_user" FOREIGN KEY ("tenant_id","partner_user_id") REFERENCES "public"."partner_users"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_candidate_messages" ADD CONSTRAINT "fk_pcm_candidate" FOREIGN KEY ("tenant_id","candidate_id") REFERENCES "public"."candidates"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_candidate_messages" ADD CONSTRAINT "fk_pcm_application" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_hoc_partner_domains" ADD CONSTRAINT "ad_hoc_partner_domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_hoc_partner_domains" ADD CONSTRAINT "fk_ad_hoc_partner_org" FOREIGN KEY ("tenant_id","partner_org_id") REFERENCES "public"."partner_orgs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_partner_orgs_tenant_tier_active" ON "partner_orgs" USING btree ("tenant_id","tier","active");--> statement-breakpoint
CREATE INDEX "idx_partner_orgs_tenant_name" ON "partner_orgs" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_partner_users_tenant_user" ON "partner_users" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_partner_users_org_active" ON "partner_users" USING btree ("tenant_id","partner_org_id","active");--> statement-breakpoint
CREATE INDEX "idx_partner_users_email" ON "partner_users" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_partner_invitations_live_token" ON "partner_invitations" USING btree ("tenant_id","token_hash") WHERE consumed_at IS NULL AND revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_partner_invitations_org_email" ON "partner_invitations" USING btree ("tenant_id","partner_org_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_partner_assignments_active" ON "partner_assignments" USING btree ("tenant_id","partner_org_id","requisition_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "idx_partner_assignments_req_status" ON "partner_assignments" USING btree ("tenant_id","requisition_id","status");--> statement-breakpoint
CREATE INDEX "idx_partner_assignments_partner_status" ON "partner_assignments" USING btree ("tenant_id","partner_org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_active_claim_per_person" ON "candidate_ownership_claims" USING btree ("tenant_id","person_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "idx_claims_partner_status_claimed" ON "candidate_ownership_claims" USING btree ("tenant_id","partner_org_id","status","claimed_at");--> statement-breakpoint
CREATE INDEX "idx_claims_active_expiry" ON "candidate_ownership_claims" USING btree ("tenant_id","expires_at") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "idx_dedup_tenant_chrono" ON "candidate_dedup_attempts" USING btree ("tenant_id","attempted_at");--> statement-breakpoint
CREATE INDEX "idx_dedup_tenant_matched_person" ON "candidate_dedup_attempts" USING btree ("tenant_id","matched_person_id","attempted_at") WHERE matched_person_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_dedup_tenant_decision" ON "candidate_dedup_attempts" USING btree ("tenant_id","decision","attempted_at");--> statement-breakpoint
CREATE INDEX "idx_pcm_candidate_chrono" ON "partner_candidate_messages" USING btree ("tenant_id","candidate_id","sent_at");--> statement-breakpoint
CREATE INDEX "idx_pcm_partner_user_chrono" ON "partner_candidate_messages" USING btree ("tenant_id","partner_user_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_ad_hoc_domain_per_tenant" ON "ad_hoc_partner_domains" USING btree ("tenant_id","domain") WHERE active = true;--> statement-breakpoint
CREATE INDEX "idx_ad_hoc_partner_org_active" ON "ad_hoc_partner_domains" USING btree ("tenant_id","partner_org_id","active");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "partner_orgs" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "partner_users" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "partner_invitations" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "partner_assignments" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "candidate_ownership_claims" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation_select" ON "candidate_dedup_attempts" AS PERMISSIVE FOR SELECT TO "authenticated" USING (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "candidate_dedup_attempts" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "partner_candidate_messages" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ad_hoc_partner_domains" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());