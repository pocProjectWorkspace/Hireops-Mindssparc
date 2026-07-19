-- =====================================================================
-- 0074_panel_02_interview_prep.sql — PANEL-02 (hand-written)
--
-- The drizzle snapshot chain is behind the live schema (known debt), so this
-- migration is hand-written rather than drizzle-kit generated. Creates the
-- interview_prep cache table (one real-AI prep per interview, regenerate =
-- ON CONFLICT replace) mirroring requisition_feasibility (0062): compound
-- (tenant_id, id) unique, per-subject unique, compound tenant FKs (interview
-- CASCADE, generated_by RESTRICT), tenant_isolation policy, RLS enabled.
-- FORCE RLS + audit trigger land in the 0075/0076 companions.
-- =====================================================================

CREATE TABLE "interview_prep" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"interview_id" uuid NOT NULL,
	"focus_areas" jsonb NOT NULL,
	"probing_questions" jsonb NOT NULL,
	"model" text,
	"prompt_version" text,
	"generated_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_interview_prep_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_interview_prep_per_interview" UNIQUE("tenant_id","interview_id")
);
--> statement-breakpoint
ALTER TABLE "interview_prep" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "interview_prep" ADD CONSTRAINT "interview_prep_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_prep" ADD CONSTRAINT "fk_interview_prep_interview" FOREIGN KEY ("tenant_id","interview_id") REFERENCES "public"."interviews"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_prep" ADD CONSTRAINT "fk_interview_prep_generated_by" FOREIGN KEY ("tenant_id","generated_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_interview_prep_interview" ON "interview_prep" USING btree ("tenant_id","interview_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "interview_prep" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
