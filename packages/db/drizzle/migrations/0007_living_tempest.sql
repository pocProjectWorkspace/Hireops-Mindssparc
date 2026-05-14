CREATE TYPE "public"."knockout_type" AS ENUM('boolean', 'numeric_min', 'numeric_max', 'enum');--> statement-breakpoint
CREATE TABLE "requisitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"jd_version_id" uuid NOT NULL,
	"headcount_envelope_id" uuid,
	"primary_recruiter_id" uuid NOT NULL,
	"hiring_manager_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"number_of_openings" integer DEFAULT 1 NOT NULL,
	"target_start_date" date,
	"posted_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"is_public" boolean DEFAULT false NOT NULL,
	"public_slug" text,
	"reason_for_hold" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requisitions_status_check" CHECK ("requisitions"."status" IN ('draft', 'pending_approval', 'approved', 'on_hold', 'posted', 'filled', 'cancelled', 'closed')),
	CONSTRAINT "requisitions_openings_check" CHECK ("requisitions"."number_of_openings" >= 1),
	CONSTRAINT "requisitions_posting_window_check" CHECK (("requisitions"."posted_at" IS NULL OR "requisitions"."expires_at" IS NULL OR "requisitions"."posted_at" <= "requisitions"."expires_at"))
);
--> statement-breakpoint
ALTER TABLE "requisitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "requisition_recruiters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requisition_id" uuid NOT NULL,
	"recruiter_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_by" uuid
);
--> statement-breakpoint
ALTER TABLE "requisition_recruiters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "requisition_knockouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requisition_id" uuid NOT NULL,
	"question_text" text NOT NULL,
	"type" "knockout_type" NOT NULL,
	"threshold_value" jsonb NOT NULL,
	"source" text NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "req_knockout_source_check" CHECK ("requisition_knockouts"."source" IN ('parsed_cv', 'candidate_asserted', 'partner_asserted'))
);
--> statement-breakpoint
ALTER TABLE "requisition_knockouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "requisition_state_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requisition_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"transitioned_by" uuid,
	"transitioned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "req_transition_to_status_check" CHECK ("requisition_state_transitions"."to_status" IN ('draft', 'pending_approval', 'approved', 'on_hold', 'posted', 'filled', 'cancelled', 'closed')),
	CONSTRAINT "req_transition_from_status_check" CHECK ("requisition_state_transitions"."from_status" IS NULL OR "requisition_state_transitions"."from_status" IN ('draft', 'pending_approval', 'approved', 'on_hold', 'posted', 'filled', 'cancelled', 'closed'))
);
--> statement-breakpoint
ALTER TABLE "requisition_state_transitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_jd_version_id_jd_versions_id_fk" FOREIGN KEY ("jd_version_id") REFERENCES "public"."jd_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_headcount_envelope_id_headcount_envelopes_id_fk" FOREIGN KEY ("headcount_envelope_id") REFERENCES "public"."headcount_envelopes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_primary_recruiter_id_tenant_user_memberships_id_fk" FOREIGN KEY ("primary_recruiter_id") REFERENCES "public"."tenant_user_memberships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_hiring_manager_id_tenant_user_memberships_id_fk" FOREIGN KEY ("hiring_manager_id") REFERENCES "public"."tenant_user_memberships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_created_by_tenant_user_memberships_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."tenant_user_memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisition_recruiters" ADD CONSTRAINT "requisition_recruiters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisition_recruiters" ADD CONSTRAINT "requisition_recruiters_requisition_id_requisitions_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "public"."requisitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisition_recruiters" ADD CONSTRAINT "requisition_recruiters_recruiter_id_tenant_user_memberships_id_fk" FOREIGN KEY ("recruiter_id") REFERENCES "public"."tenant_user_memberships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisition_recruiters" ADD CONSTRAINT "requisition_recruiters_assigned_by_tenant_user_memberships_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."tenant_user_memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisition_knockouts" ADD CONSTRAINT "requisition_knockouts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisition_knockouts" ADD CONSTRAINT "requisition_knockouts_requisition_id_requisitions_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "public"."requisitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisition_state_transitions" ADD CONSTRAINT "requisition_state_transitions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisition_state_transitions" ADD CONSTRAINT "requisition_state_transitions_requisition_id_requisitions_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "public"."requisitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisition_state_transitions" ADD CONSTRAINT "requisition_state_transitions_transitioned_by_tenant_user_memberships_id_fk" FOREIGN KEY ("transitioned_by") REFERENCES "public"."tenant_user_memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_requisitions_public_slug" ON "requisitions" USING btree ("tenant_id","public_slug") WHERE public_slug IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_requisitions_position" ON "requisitions" USING btree ("tenant_id","position_id");--> statement-breakpoint
CREATE INDEX "idx_requisitions_envelope" ON "requisitions" USING btree ("headcount_envelope_id");--> statement-breakpoint
CREATE INDEX "idx_requisitions_recruiter" ON "requisitions" USING btree ("primary_recruiter_id");--> statement-breakpoint
CREATE INDEX "idx_requisitions_status" ON "requisitions" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_req_recruiters_unique" ON "requisition_recruiters" USING btree ("requisition_id","recruiter_id");--> statement-breakpoint
CREATE INDEX "idx_req_knockouts_order" ON "requisition_knockouts" USING btree ("requisition_id","order_index");--> statement-breakpoint
CREATE INDEX "idx_req_transitions_chrono" ON "requisition_state_transitions" USING btree ("requisition_id","transitioned_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "requisitions" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "requisition_recruiters" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "requisition_knockouts" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation_select" ON "requisition_state_transitions" AS PERMISSIVE FOR SELECT TO "authenticated" USING (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "requisition_state_transitions" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (tenant_id = current_tenant_id());