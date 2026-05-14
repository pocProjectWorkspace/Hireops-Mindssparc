-- DB-TENANT-FK: replace single-column cross-table FKs with compound
-- (tenant_id, id) FKs so cross-tenant references are rejected at the DB
-- regardless of who's writing (service_role, bulk imports, etc.).
--
-- Statement order matters: a compound FK referencing (tenant_id, id)
-- requires a matching UNIQUE constraint on the target table. So we
--   1. drop the old single-column FKs
--   2. add UNIQUE (tenant_id, id) to every domain table
--   3. add the new compound FKs
-- Drizzle-kit emits these in a different order — we reordered manually.

-- ---------- 1. Drop old single-column FKs ----------

ALTER TABLE "business_units" DROP CONSTRAINT "business_units_parent_business_unit_id_fkey";
--> statement-breakpoint
ALTER TABLE "tenant_user_memberships" DROP CONSTRAINT "tenant_user_memberships_manager_id_fkey";
--> statement-breakpoint
ALTER TABLE "tenant_user_memberships" DROP CONSTRAINT "tenant_user_memberships_business_unit_id_fkey";
--> statement-breakpoint
ALTER TABLE "headcount_envelopes" DROP CONSTRAINT "headcount_envelopes_business_unit_id_business_units_id_fk";
--> statement-breakpoint
ALTER TABLE "headcount_envelopes" DROP CONSTRAINT "headcount_envelopes_approved_by_tenant_user_memberships_id_fk";
--> statement-breakpoint
ALTER TABLE "positions" DROP CONSTRAINT "positions_business_unit_id_business_units_id_fk";
--> statement-breakpoint
ALTER TABLE "positions" DROP CONSTRAINT "positions_hiring_manager_id_tenant_user_memberships_id_fk";
--> statement-breakpoint
ALTER TABLE "positions" DROP CONSTRAINT "positions_created_by_tenant_user_memberships_id_fk";
--> statement-breakpoint
ALTER TABLE "jd_versions" DROP CONSTRAINT "jd_versions_position_id_positions_id_fk";
--> statement-breakpoint
ALTER TABLE "jd_versions" DROP CONSTRAINT "jd_versions_created_by_tenant_user_memberships_id_fk";
--> statement-breakpoint
ALTER TABLE "jd_versions" DROP CONSTRAINT "jd_versions_approved_by_tenant_user_memberships_id_fk";
--> statement-breakpoint
ALTER TABLE "jd_skills" DROP CONSTRAINT "jd_skills_jd_version_id_jd_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "requisitions" DROP CONSTRAINT "requisitions_position_id_positions_id_fk";
--> statement-breakpoint
ALTER TABLE "requisitions" DROP CONSTRAINT "requisitions_jd_version_id_jd_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "requisitions" DROP CONSTRAINT "requisitions_headcount_envelope_id_headcount_envelopes_id_fk";
--> statement-breakpoint
ALTER TABLE "requisitions" DROP CONSTRAINT "requisitions_primary_recruiter_id_tenant_user_memberships_id_fk";
--> statement-breakpoint
ALTER TABLE "requisitions" DROP CONSTRAINT "requisitions_hiring_manager_id_tenant_user_memberships_id_fk";
--> statement-breakpoint
ALTER TABLE "requisitions" DROP CONSTRAINT "requisitions_created_by_tenant_user_memberships_id_fk";
--> statement-breakpoint
ALTER TABLE "requisition_recruiters" DROP CONSTRAINT "requisition_recruiters_requisition_id_requisitions_id_fk";
--> statement-breakpoint
ALTER TABLE "requisition_recruiters" DROP CONSTRAINT "requisition_recruiters_recruiter_id_tenant_user_memberships_id_fk";
--> statement-breakpoint
ALTER TABLE "requisition_recruiters" DROP CONSTRAINT "requisition_recruiters_assigned_by_tenant_user_memberships_id_fk";
--> statement-breakpoint
ALTER TABLE "requisition_knockouts" DROP CONSTRAINT "requisition_knockouts_requisition_id_requisitions_id_fk";
--> statement-breakpoint
ALTER TABLE "requisition_state_transitions" DROP CONSTRAINT "requisition_state_transitions_requisition_id_requisitions_id_fk";
--> statement-breakpoint
ALTER TABLE "requisition_state_transitions" DROP CONSTRAINT "requisition_state_transitions_transitioned_by_tenant_user_memberships_id_fk";
--> statement-breakpoint

-- ---------- 2. Add UNIQUE (tenant_id, id) — must exist before compound FKs ----------

ALTER TABLE "business_units" ADD CONSTRAINT "uniq_business_units_tenant_id_id" UNIQUE("tenant_id","id");
--> statement-breakpoint
ALTER TABLE "tenant_user_memberships" ADD CONSTRAINT "uniq_tenant_user_memberships_tenant_id_id" UNIQUE("tenant_id","id");
--> statement-breakpoint
ALTER TABLE "headcount_envelopes" ADD CONSTRAINT "uniq_headcount_envelopes_tenant_id_id" UNIQUE("tenant_id","id");
--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "uniq_positions_tenant_id_id" UNIQUE("tenant_id","id");
--> statement-breakpoint
ALTER TABLE "jd_versions" ADD CONSTRAINT "uniq_jd_versions_tenant_id_id" UNIQUE("tenant_id","id");
--> statement-breakpoint
ALTER TABLE "jd_skills" ADD CONSTRAINT "uniq_jd_skills_tenant_id_id" UNIQUE("tenant_id","id");
--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "uniq_requisitions_tenant_id_id" UNIQUE("tenant_id","id");
--> statement-breakpoint
ALTER TABLE "requisition_recruiters" ADD CONSTRAINT "uniq_requisition_recruiters_tenant_id_id" UNIQUE("tenant_id","id");
--> statement-breakpoint
ALTER TABLE "requisition_knockouts" ADD CONSTRAINT "uniq_requisition_knockouts_tenant_id_id" UNIQUE("tenant_id","id");
--> statement-breakpoint
ALTER TABLE "requisition_state_transitions" ADD CONSTRAINT "uniq_requisition_state_transitions_tenant_id_id" UNIQUE("tenant_id","id");
--> statement-breakpoint

-- ---------- 3. Add new compound FKs ----------

ALTER TABLE "business_units" ADD CONSTRAINT "fk_business_units_parent" FOREIGN KEY ("tenant_id","parent_business_unit_id") REFERENCES "public"."business_units"("tenant_id","id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tenant_user_memberships" ADD CONSTRAINT "fk_membership_manager" FOREIGN KEY ("tenant_id","manager_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tenant_user_memberships" ADD CONSTRAINT "fk_membership_business_unit" FOREIGN KEY ("tenant_id","business_unit_id") REFERENCES "public"."business_units"("tenant_id","id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "headcount_envelopes" ADD CONSTRAINT "fk_headcount_envelopes_business_unit" FOREIGN KEY ("tenant_id","business_unit_id") REFERENCES "public"."business_units"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "headcount_envelopes" ADD CONSTRAINT "fk_headcount_envelopes_approved_by" FOREIGN KEY ("tenant_id","approved_by") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "fk_positions_business_unit" FOREIGN KEY ("tenant_id","business_unit_id") REFERENCES "public"."business_units"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "fk_positions_hiring_manager" FOREIGN KEY ("tenant_id","hiring_manager_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "fk_positions_created_by" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "jd_versions" ADD CONSTRAINT "fk_jd_versions_position" FOREIGN KEY ("tenant_id","position_id") REFERENCES "public"."positions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "jd_versions" ADD CONSTRAINT "fk_jd_versions_created_by" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "jd_versions" ADD CONSTRAINT "fk_jd_versions_approved_by" FOREIGN KEY ("tenant_id","approved_by") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "jd_skills" ADD CONSTRAINT "fk_jd_skills_jd_version" FOREIGN KEY ("tenant_id","jd_version_id") REFERENCES "public"."jd_versions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "fk_requisitions_position" FOREIGN KEY ("tenant_id","position_id") REFERENCES "public"."positions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "fk_requisitions_jd_version" FOREIGN KEY ("tenant_id","jd_version_id") REFERENCES "public"."jd_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "fk_requisitions_envelope" FOREIGN KEY ("tenant_id","headcount_envelope_id") REFERENCES "public"."headcount_envelopes"("tenant_id","id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "fk_requisitions_primary_recruiter" FOREIGN KEY ("tenant_id","primary_recruiter_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "fk_requisitions_hiring_manager" FOREIGN KEY ("tenant_id","hiring_manager_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "fk_requisitions_created_by" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "requisition_recruiters" ADD CONSTRAINT "fk_requisition_recruiters_requisition" FOREIGN KEY ("tenant_id","requisition_id") REFERENCES "public"."requisitions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "requisition_recruiters" ADD CONSTRAINT "fk_requisition_recruiters_recruiter" FOREIGN KEY ("tenant_id","recruiter_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "requisition_recruiters" ADD CONSTRAINT "fk_requisition_recruiters_assigned_by" FOREIGN KEY ("tenant_id","assigned_by") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "requisition_knockouts" ADD CONSTRAINT "fk_requisition_knockouts_requisition" FOREIGN KEY ("tenant_id","requisition_id") REFERENCES "public"."requisitions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "requisition_state_transitions" ADD CONSTRAINT "fk_requisition_transitions_requisition" FOREIGN KEY ("tenant_id","requisition_id") REFERENCES "public"."requisitions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "requisition_state_transitions" ADD CONSTRAINT "fk_requisition_transitions_transitioned_by" FOREIGN KEY ("tenant_id","transitioned_by") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE set null ON UPDATE no action;
